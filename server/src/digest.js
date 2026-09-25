import { createHash } from 'node:crypto';

/**
 * 参数摘要：对稳定发布标识与参数文本计算摘要，
 * 同一份参数在所有采集器与服务端必须得到同一个摘要。
 */
export function parameterDigest(stableId, payloadText) {
  return createHash('sha256')
    .update(`stable:${stableId}\n`)
    .update(payloadText)
    .digest('hex');
}
