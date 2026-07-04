/**
 * 把 provider 端点的错误信息包装成对用户可操作的提示。
 * 不预判能力:带图直发,端点报错时据错误文本给出换模型建议。视觉优先于工具。
 */
export function describeProviderError(msg: string): string {
  if (/image|vision|multimodal|视觉|不支持.*图/i.test(msg)) {
    return `${msg}(当前模型可能不支持识图,请在设置里换支持视觉的模型,如 gpt-4o、qwen-vl、GLM-4V、本地 llava)`
  }
  if (/tool|function/i.test(msg)) {
    return `${msg}(当前模型可能不支持工具调用,请换支持 function calling 的模型)`
  }
  return msg
}
