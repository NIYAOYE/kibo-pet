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
            with _infer_lock:
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

    genie.load_character(CHARACTER_NAME, args.onnx_model_dir, args.language)
    with open(args.ref_text_file, "r", encoding="utf-8") as f:
        ref_text = f.read().strip()
    genie.set_reference_audio(CHARACTER_NAME, args.ref_audio, ref_text, args.language)

    print("READY", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
