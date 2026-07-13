"""开发时工具:把 GPT-SoVITS v2/v2ProPlus 的 .ckpt(GPT/T2S)+ .pth(SoVITS/VITS)模型转换成
Genie-TTS 用的 ONNX 目录,供 pet.json 的 voice.onnxModel 字段引用。

只在开发者/宠物包作者自己机器上跑一次,产出的 ONNX 文件随宠物包一起提交;最终用户的应用运行时
不需要装 torch,也不需要跑这个脚本。

用法:
    python tools/convert-voice-to-onnx/convert.py \
        --ckpt "E:\\GST\\...\\Alice_v2pro-e15.ckpt" \
        --pth "E:\\GST\\...\\Alice_v2pro_e8_s1032.pth" \
        --out "pets/alice/voice/alice-onnx"

依赖:pip install torch genie-tts (torch 只在这个脚本里用得到)
"""
import argparse
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--ckpt', required=True, help='GPT/T2S 模型 .ckpt 路径')
    parser.add_argument('--pth', required=True, help='SoVITS/VITS 模型 .pth 路径')
    parser.add_argument('--out', required=True, help='输出的 ONNX 目录')
    args = parser.parse_args()

    try:
        import genie_tts as genie
    except ImportError:
        sys.stderr.write('未安装 genie-tts,请先: pip install genie-tts\n')
        sys.exit(1)

    print(f'转换中: {args.ckpt} + {args.pth} -> {args.out}')
    genie.convert_to_onnx(
        torch_ckpt_path=args.ckpt,
        torch_pth_path=args.pth,
        output_dir=args.out,
    )
    print('转换完成。')


if __name__ == '__main__':
    main()
