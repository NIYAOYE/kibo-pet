"""Pet-Agent 语音 sidecar —— GSV-TTS-Lite 的最小推理适配层。

不含 GSV-TTS-Lite 自带的 WebUI / ASR 自动识别 / 批量推理 / api_v2 兼容层——
只暴露一个 /speak 端点(SSE),启动时一次性绑定单个 GPT+SoVITS 模型与参考音频/
文本(随 Pet-Agent 的宠物包走,见 pet.json 的 voice 字段)。

用 Python 标准库 http.server 实现,不引入 fastapi/uvicorn/pydantic/starlette——
唯一的调用方是 Pet-Agent 自己的主进程,请求形状固定,用不上那些库的路由/校验/
文档机制,少一环安装失败点。
"""
import sys
import json
import base64
import argparse
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from gsv_tts import TTS
from gsv_tts.LangSegment import LangSegment

tts: "TTS | None" = None
REF_AUDIO = ""
REF_TEXT = ""
_infer_lock = threading.Lock()


def _apply_language(segments, default_lang):
    """按请求传来的 segments 构造 LangSegment.getTexts 的返回值,替代它自己的语言检测。

    之前的实现监听 language 参数、强制整段按单一语言发音,是为了修复纯汉字、不含假名的
    日语行被自动检测误判成中文的问题,代价是顺带关掉了混合语言能力。现在改成直接用请求方
    (已经知道目标语言、也已经用 splitByScript 切好英文/非英文片段)算好的 segments,不需要
    再让 LangSegment 自己去猜——原问题(不需要猜)和混合语言能力(segments 里天然保留了
    英文片段)可以同时满足。

    但 tts.infer_stream 在 is_cut_text=True 时会把整句按 cut_minlen 切成多个小片段,而
    LangSegment.getTexts 具体是"整句只调一次"还是"每个切片各调一次"取决于 gsv_tts 内部
    实现——这个项目里没有真实装了 gsv_tts 的 Python 环境能验证。如果是后者,只按 segments
    原样返回整句列表会导致每个切片都拿到全句文本、整句音频被合成并播放多次(见 final review
    发现)。因此这里同时兼容两种调用方式:传入文本如果等于全部 segments 拼接后的整句,说明
    这是"整句一次性调用",按 segments 逐段发音;否则视为"按切片调用",退回到本功能加入前的
    旧行为——原样回显该片段、按 default_lang(即请求里的 language,默认 auto)单一语言发音,
    不依赖对内部调用方式的猜测。segments 为空(理论上不会,voiceProvider 至少会给一个整段)
    时 combined 为空串,任何非空切片都会走回退分支。必须在持有 _infer_lock 时调用。
    """
    combined = "".join(s["text"] for s in segments)

    def get_texts(text):
        if text == combined:
            return [{"lang": s["lang"], "text": s["text"]} for s in segments if s["text"]]
        return (
            []
            if text is None or len(text.strip()) == 0
            else [{"lang": default_lang, "text": text}]
        )

    LangSegment.getTexts = get_texts


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()

    def do_POST(self):
        if self.path != "/speak":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_response(400)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        try:
            stream_mode = "sentence" if body.get("synthesisChunking") == "sentence" else "token"
            with _infer_lock:
                default_lang = body.get("language", "auto")
                _apply_language(body.get("segments") or [{"lang": default_lang, "text": body["text"]}], default_lang)
                for clip in tts.infer_stream(
                    spk_audio_path=REF_AUDIO,
                    prompt_audio_path=REF_AUDIO,
                    prompt_audio_text=REF_TEXT,
                    text=body["text"],
                    is_cut_text=bool(body.get("isCutText", True)),
                    cut_minlen=int(body.get("cutMinLen", 10)),
                    cut_mute=float(body.get("cutMute", 0.3)),
                    stream_mode=stream_mode,
                    top_k=int(body.get("topK", 15)),
                    top_p=float(body.get("topP", 1.0)),
                    temperature=float(body.get("temperature", 1.0)),
                    repetition_penalty=float(body.get("repetitionPenalty", 1.35)),
                    noise_scale=float(body.get("noiseScale", 0.5)),
                    speed=float(body.get("speed", 1.0)),
                    debug=False,
                ):
                    audio_b64 = base64.b64encode(clip.audio_data.tobytes()).decode("ascii")
                    payload = json.dumps({"audio": audio_b64, "sampleRate": clip.samplerate})
                    self.wfile.write(("event: audio\ndata: %s\n\n" % payload).encode("utf-8"))
                    self.wfile.flush()
            self.wfile.write(b"event: done\ndata: {}\n\n")
            self.wfile.flush()
        except Exception as e:
            err = json.dumps({"error": str(e)})
            self.wfile.write(("event: error\ndata: %s\n\n" % err).encode("utf-8"))
            self.wfile.flush()


def main():
    global tts, REF_AUDIO, REF_TEXT

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int)
    parser.add_argument("--gpt-model")
    parser.add_argument("--sovits-model")
    parser.add_argument("--ref-audio")
    parser.add_argument("--ref-text-file")
    parser.add_argument("--device", default=None)
    parser.add_argument("--use-flash-attn", action="store_true")
    parser.add_argument(
        "--models-dir", default=None,
        help="gsv_tts 基础预训练模型缓存目录;不传则用其默认的 ~/.cache/gsv(全局共享,"
             "不随语音运行时可移植/可导出,且 CPU/GPU 变体会互相踩踏同一目录——见 Task 记录)。"
             "传入时应指向语音运行时安装目录下的专属子目录。"
    )
    parser.add_argument(
        "--warm-start", action="store_true",
        help="仅构造 TTS(触发 chinese-hubert/chinese-roberta 等基础预训练模型下载)后立即退出,"
             "不加载 GPT/SoVITS 模型、不读参考音频文本、不起 HTTP 服务——安装阶段用来\"预热\"模型缓存。"
    )
    args = parser.parse_args()

    if args.warm_start:
        TTS(use_bert=True, device=args.device, use_flash_attn=args.use_flash_attn, models_dir=args.models_dir)
        print("READY", flush=True)
        return

    if not (args.port and args.gpt_model and args.sovits_model and args.ref_audio and args.ref_text_file):
        parser.error("--port/--gpt-model/--sovits-model/--ref-audio/--ref-text-file 均为必填(除非传 --warm-start)")

    REF_AUDIO = args.ref_audio
    with open(args.ref_text_file, "r", encoding="utf-8") as f:
        REF_TEXT = f.read().strip()

    tts = TTS(use_bert=True, device=args.device, use_flash_attn=args.use_flash_attn, models_dir=args.models_dir)
    tts.load_gpt_model(args.gpt_model)
    tts.load_sovits_model(args.sovits_model)

    # 首次真实推理会触发 CUDA kernel 编译/cuDNN 算法选择,耗时明显长于后续调用。
    # 在这里用参考音频/文本跑一次丢弃结果的预热推理,把这个成本移到启动阶段
    # (本来就是一个有加载等待的阶段),而不是让用户等第一句真实回复。
    try:
        for _ in tts.infer_stream(
            spk_audio_path=REF_AUDIO,
            prompt_audio_path=REF_AUDIO,
            prompt_audio_text=REF_TEXT,
            text=REF_TEXT,
            is_cut_text=True,
            cut_minlen=10,
            cut_mute=0.3,
            stream_mode="token",
            top_k=15,
            top_p=1.0,
            temperature=1.0,
            repetition_penalty=1.35,
            noise_scale=0.5,
            speed=1.0,
            debug=False,
        ):
            pass
    except Exception as e:
        sys.stderr.write("[voice] 预热推理失败,不影响正常启动:%s\n" % e)
        sys.stderr.flush()

    print("READY", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
