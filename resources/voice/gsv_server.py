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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from gsv_tts import TTS

tts: "TTS | None" = None
REF_AUDIO = ""
REF_TEXT = ""


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
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        try:
            stream_mode = "sentence" if body.get("synthesisChunking") == "sentence" else "token"
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
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--gpt-model", required=True)
    parser.add_argument("--sovits-model", required=True)
    parser.add_argument("--ref-audio", required=True)
    parser.add_argument("--ref-text-file", required=True)
    parser.add_argument("--device", default=None)
    parser.add_argument("--use-flash-attn", action="store_true")
    args = parser.parse_args()

    REF_AUDIO = args.ref_audio
    with open(args.ref_text_file, "r", encoding="utf-8") as f:
        REF_TEXT = f.read().strip()

    tts = TTS(use_bert=True, device=args.device, use_flash_attn=args.use_flash_attn)
    tts.load_gpt_model(args.gpt_model)
    tts.load_sovits_model(args.sovits_model)

    print("READY", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
