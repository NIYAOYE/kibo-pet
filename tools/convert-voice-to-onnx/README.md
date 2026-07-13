# convert-voice-to-onnx

开发时一次性工具:把 GPT-SoVITS `.ckpt`(GPT/T2S)+ `.pth`(SoVITS/VITS)模型转换成 Genie-TTS
用的 ONNX 目录,产出后随宠物包一起提交到 `pets/<id>/voice/`,给 `pet.json` 的 `voice.onnxModel`
字段引用。只在开发者/宠物包作者自己机器上跑,不进入应用运行时——最终用户不需要装 torch。

## 依赖

```bash
pip install torch genie-tts
```

## 用法

```bash
python convert.py --ckpt <GPT模型.ckpt> --pth <SoVITS模型.pth> --out <输出目录>
```

转换目前只支持 GPT-SoVITS V2 / V2ProPlus(Genie-TTS 的官方限制)。若源模型是 v2Pro(不是
V2ProPlus),兼容性未知,以实际跑通为准——失败时看 `genie_tts.convert_to_onnx` 抛出的具体报错。
