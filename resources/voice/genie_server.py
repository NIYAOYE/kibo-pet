"""Pet-Agent 语音 sidecar —— Genie-TTS 的最小推理适配层。

不含 Genie-TTS 自带的 Server.py(FastAPI + audio/wav 流式响应,协议形态跟这里的 SSE 不一样)/
GUI/预定义角色下载/声纹相关功能——只暴露一个 /speak 端点(SSE)+ 一个 --download-data 一次性
下载模式,启动时一次性绑定单个 ONNX 角色模型与参考音频/文本(随 Pet-Agent 的宠物包走,见
pet.json 的 voice 字段)。

用 Python 标准库 http.server 实现(理由同 gsv_server.py):唯一调用方是 Pet-Agent 自己的主进程,
请求形状固定,用不上 genie-tts 自带 Server.py 依赖的 fastapi/uvicorn/pydantic 的路由/校验机制。

音频协议:genie_tts.tts_async() 内部(Core/TTSPlayer.py)回调给的是 16-bit PCM(int16)字节,
32000Hz 单声道——这里转成 float32 再 base64,和 gsv_server.py 吐出的 PcmChunk 协议完全一致,
渲染层 pcmPlayer.ts 不用区分后端。

语言:/speak 请求体里的 language 字段按次生效,效果对齐 gsv_server.py 的 _apply_language()——但
genie_tts 没有对应的公开 API。set_reference_audio()/load_character() 都改不了"要合成的新文本"用
什么语言音素化:前者的 language 只影响参考音频自身转写文本的音素(Audio/ReferenceAudio.py 的
set_text()),后者对已加载过的角色直接短路返回、不会更新语言。目标文本真正读的语言来自
ModelManager.character_to_language[角色名](TTSPlayer._tts_worker_loop 里 model_manager.get(...).LANGUAGE
=> Core/Inference.py 的 GENIE.tts(..., language=...)),这个字典只在角色第一次 load_character()
时写入一次,此后没有公开途径能改。do_POST 每次请求前直接改写这个内部字典项(见下方注释),
不是公开 API,但目前没有更干净的公开途径。
"""
import sys
import json
import time
import base64
import argparse
import asyncio
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

CHARACTER_NAME = "pet"
_infer_lock = threading.Lock()
REF_AUDIO = None
REF_TEXT = None
BASE_LANGUAGE = None


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

        import genie_tts as genie

        async def run():
            async for chunk in genie.tts_async(
                character_name=CHARACTER_NAME,
                text=body["text"],
                play=False,
                split_sentence=False,
            ):
                pcm_f32 = (np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0)
                audio_b64 = base64.b64encode(pcm_f32.tobytes()).decode("ascii")
                payload = json.dumps({"audio": audio_b64, "sampleRate": 32000})
                self.wfile.write(("event: audio\ndata: %s\n\n" % payload).encode("utf-8"))
                self.wfile.flush()

        try:
            requested_lang = body.get("language", "auto")
            lang = requested_lang if requested_lang in ("zh", "ja", "en") else BASE_LANGUAGE
            with _infer_lock:
                # genie_tts 的公开 API(set_reference_audio/load_character)都改不了"要合成的新文本"用什么
                # 语言音素化——那个语言是在角色第一次 load_character() 时写死进 ModelManager 内部的
                # character_to_language 字典,之后任何公开调用都不会再更新它(load_character 对已加载
                # 角色直接短路返回,set_reference_audio 的 language 只影响参考音频自身转写文本,两者都
                # 不是目标文本的音素化语言)。TTSPlayer._tts_worker_loop 每次合成都会重新读这个字典
                # (model_manager.get(character_name).LANGUAGE),所以直接改写它是唯一能在不重新加载
                # 整个角色模型(代价高、且 load_character 对已加载角色是 no-op 做不到)的前提下,做到
                # 按请求切换目标文本发音语言的办法——这是伸手改 genie_tts 的内部私有状态,不是公开 API,
                # 但目前没有更干净的公开途径;如果 genie_tts 未来版本改了内部实现,这里最坏情况是又退回
                # "始终用角色基准语言"的旧行为,不会崩溃。
                from genie_tts.ModelManager import model_manager
                from genie_tts.Utils.Language import normalize_language
                model_manager.character_to_language[CHARACTER_NAME.lower()] = normalize_language(lang)
                asyncio.run(run())
            self.wfile.write(b"event: done\ndata: {}\n\n")
            self.wfile.flush()
        except Exception as e:
            err = json.dumps({"error": str(e)})
            self.wfile.write(("event: error\ndata: %s\n\n" % err).encode("utf-8"))
            self.wfile.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int)
    parser.add_argument("--onnx-model-dir")
    parser.add_argument("--ref-audio")
    parser.add_argument("--ref-text-file")
    parser.add_argument("--language", choices=["zh", "ja", "en"])
    parser.add_argument(
        "--download-data", action="store_true",
        help="只触发 genie_tts 基础预训练模型下载(首次约 391MB)后立即退出,不加载角色模型、"
             "不起 HTTP 服务——安装阶段用来预置资源,避免第一次真实请求时才触发下载。"
    )
    args = parser.parse_args()

    import genie_tts as genie

    if args.download_data:
        last_error = None
        for attempt in range(1, 4):
            try:
                genie.download_genie_data()
                last_error = None
                break
            except Exception as e:
                last_error = e
                if attempt < 3:
                    print(f"[voice] 数据下载第 {attempt} 次尝试失败,{2 * attempt} 秒后重试: {e}", flush=True)
                    time.sleep(2 * attempt)
        if last_error is not None:
            raise last_error
        print("READY", flush=True)
        return

    if not (args.port and args.onnx_model_dir and args.ref_audio and args.ref_text_file and args.language):
        parser.error("--port/--onnx-model-dir/--ref-audio/--ref-text-file/--language 均为必填(除非传 --download-data)")

    global REF_AUDIO, REF_TEXT, BASE_LANGUAGE
    genie.load_character(CHARACTER_NAME, args.onnx_model_dir, args.language)
    REF_AUDIO = args.ref_audio
    BASE_LANGUAGE = args.language
    with open(args.ref_text_file, "r", encoding="utf-8") as f:
        REF_TEXT = f.read().strip()
    genie.set_reference_audio(CHARACTER_NAME, REF_AUDIO, REF_TEXT, BASE_LANGUAGE)

    print("READY", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
