/**
 * 故障注入钩子（仅由环境变量驱动，用于崩溃恢复验证）。
 * CRASH_POINT=after-device-stage：设备暂存成功、回执落库之前立即退出，
 * 精确制造“设备已暂存但服务端无回执”的中断现场。
 */
let crashed = false;

export function maybeCrash(point) {
  if (crashed) return;
  if (process.env.CRASH_POINT !== point) return;
  crashed = true;
  // 给落盘中的设备模拟器一点时间完成自己的原子写
  setImmediate(() => process.exit(99));
  // 阻断后续执行：挂起当前 async 链直到进程退出
  return new Promise(() => {});
}
