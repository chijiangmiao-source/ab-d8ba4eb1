# 低温光学台参数发布系统

更换低温光学台控制参数时，必须让一组采集器先持有**同一份参数摘要**，再由服务端
**一次性原子推进**为当前生效版本。页面重试、进程中断、个别设备迟到都不能造成
"页面声称已发布但设备内容不一致"。

本仓库交付：

- `web/`：React 18 + Vite 发布页（提交稳定发布标识 / 目标采集器 / 参数文本，
  只读展示服务端已确认的暂存回执、汇总阶段、最终生效代次）
- `server/`：Express 真实后端 + 持久化状态机 + 采集器设备模拟器
- `scripts/verify.mjs`：代码测试 + 构建检查 + API 冒烟（含崩溃恢复、回执补记、重复发布）
- `Dockerfile` / `docker-compose.yml`：一键启动发布页及接口，内置健康检查与 verify 服务

## 一致性协议

1. **提交意图**：`POST /api/releases { stableId, payloadText, targets }`，
   服务端对 `stableId + payloadText` 计算 SHA-256 摘要，持久化发布意图并返回发布编号。
   - 同一 `stableId` + 同一载荷（同摘要）→ 幂等返回**原发布单与原结果**；
   - 同一 `stableId` + 不同载荷（异摘要）→ `409 STABLE_ID_CONFLICT`。
2. **设备暂存**：设备模拟器按 `发布编号 + 设备编号 + 摘要` **幂等暂存**并出具回执，
   独立文件持久化。服务端逐台派发并落库回执。
3. **原子推进**：仅当全部目标回执摘要均匹配时，状态机在**单次原子写**
   （临时文件 + rename）中同时写入每台设备的下一代次、生效版本与 PUBLISHED 状态。
4. **异常分支**：
   - 任一设备回执摘要不符 → 发布单进入终态 `BLOCKED`，永不推进，页面明确显示；
   - 设备迟到 / 暂存失败 → 保持 `STAGING`，不会出现"已发布"假象；
   - **进程在设备暂存成功、回执落库前退出** → 重启时 reconciler 向模拟器逐台核对，
     按设备侧事实补记回执（页面标注"重启补记"），再判断推进；核对出设备摘要不符
     同样进入 `BLOCKED`。

状态：`STAGING → PUBLISHED`（全部匹配）或 `STAGING → BLOCKED`（任一不符，终态）。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/releases` | 提交发布意图（201 新建 / 200 幂等重传 / 409 冲突） |
| GET | `/api/releases` | 发布单列表（只读） |
| GET | `/api/releases/:id` | 发布单详情：每台设备回执、汇总、生效代次 |
| POST | `/api/releases/:id/reconcile` | 触发核对补记 / 对迟到设备重新派发 |
| GET | `/api/devices` | 各设备当前生效代次 |

## 本地运行

```bash
npm install
npm run build          # 构建 React（产物由 Express 托管）
npm start              # 默认 http://localhost:8080
# 或开发模式：(cd web && npm run dev)，/api 代理到 8080
npm test               # 后端代码测试（node --test）
```

数据默认写入 `./data/`（`releases.json` 状态机、`devices.json` 设备暂存），
可用环境变量 `DATA_DIR`、`PORT` 覆盖。

## Docker / Compose

```bash
# 启动发布页及接口（宿主端口可用 HOST_PORT 配置）
HOST_PORT=8080 docker compose up -d --build app

# 验收：代码测试 + 构建检查 + API 冒烟（复核回执补记与重复发布），结束退出并给出退出码
docker compose up --build --exit-code-from verify verify
echo $?   # 0 表示全部通过
```

- 镜像内 `HEALTHCHECK` 与 compose `healthcheck` 均探测 `/api/health`；
  verify 服务通过 `depends_on: service_healthy` 等待 app 就绪后才开始冒烟。
- 崩溃恢复由 `CRASH_POINT=after-device-stage` 故障注入驱动：服务在首台设备
  暂存成功、回执落库前立即退出（99），verify 随后以干净环境重启该实例并核对补记。

## 目录

```
server/src/
  index.js           启动入口（启动即 reconcile）
  app.js             Express 路由与只读视图投影
  release-service.js 发布编排：派发、核对补记、评估推进
  store.js           发布意图/回执/代次持久化状态机（原子写、串行变更）
  simulator.js       采集器模拟器（独立持久化、幂等暂存、回执核对）
  digest.js          参数摘要
  atomic-write.js    临时文件 + rename 原子落盘
  crash-hook.js      崩溃故障注入
server/test/         状态机与崩溃恢复单元测试
web/src/             React 发布页
scripts/verify.mjs   综合验收脚本
```
