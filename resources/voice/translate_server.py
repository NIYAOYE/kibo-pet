"""Pet-Agent 本地翻译 sidecar —— NLLB-200-distilled-600M 的最小推理适配层。

只暴露一个 /translate 端点(同步 JSON,非流式——上游已经决定"整句进整句出"不做流式短语,
不需要 SSE)。用标准库 http.server 实现,不引入 fastapi/uvicorn。

分词直接用 sentencepiece,不引入 transformers/torch:NLLB 官方文档给的示例是用
transformers.AutoTokenizer 包一层,但那样会把 transformers 整个装进来。这里改用
CTranslate2 生态里常见的"纯 sentencepiece + 手工拼语言标记"写法(源语言 token 序列末尾
拼 </s> 加源语言标记,目标语言标记作为 target_prefix 传给 translate_batch,解码时去掉
回显的第一个 token)——这个写法参考自开源项目 ovos-translate-plugin-nllb 的实现,尚未在
真实 ctranslate2/sentencepiece 环境里跑过,需要真机验证(见本文件底部清单),如果目标模型的
sentencepiece 版本要求用 decode_pieces 而非 decode,或 hypotheses 的下标切法不一致,以真实
报错为准调整。
"""
import sys
import json
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ctranslate2
import sentencepiece as spm

translator: "ctranslate2.Translator | None" = None
sp: "spm.SentencePieceProcessor | None" = None

# NLLB 官方语言码约定,项目语言范围固定为 zh/ja/en 三者,不扩展。
LANG_CODES = {"zh": "zho_Hans", "ja": "jpn_Jpan", "en": "eng_Latn"}


def _translate(text: str, source: str, target: str) -> str:
    src_tag = LANG_CODES[source]
    tgt_tag = LANG_CODES[target]
    tokens = sp.encode(text, out_type=str)
    source_tokens = tokens + ["</s>", src_tag]
    result = translator.translate_batch(
        [source_tokens], target_prefix=[[tgt_tag]], beam_size=1
    )
    output_tokens = result[0].hypotheses[0][1:]  # 去掉回显的目标语言标记本身
    return sp.decode(output_tokens)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()

    def do_POST(self):
        if self.path != "/translate":
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

        try:
            text = body["text"]
            source = body["source"]
            target = body["target"]
            if source not in LANG_CODES or target not in LANG_CODES:
                raise ValueError("不支持的语言:%s -> %s" % (source, target))
            translation = _translate(text, source, target) if text.strip() else ""
            payload = json.dumps({"translation": translation})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
        except Exception as e:
            payload = json.dumps({"error": str(e)})
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))


def main():
    global translator, sp

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--model-dir", required=True,
        help="包含 model.bin/config.json/sentencepiece.bpe.model 的目录(见 translateRuntimeInstall 的下载步骤)"
    )
    args = parser.parse_args()

    sp = spm.SentencePieceProcessor()
    sp.load(args.model_dir.rstrip("/\\") + "/sentencepiece.bpe.model")
    translator = ctranslate2.Translator(args.model_dir, device="cpu")

    print("READY", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
