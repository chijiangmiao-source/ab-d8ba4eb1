import { resolve } from 'node:path';
import { ReleaseStore } from './store.js';
import { DeviceSimulator } from './simulator.js';
import { ReleaseService } from './release-service.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');
const STORE_FILE = resolve(DATA_DIR, 'releases.json');
const DEVICE_FILE = resolve(DATA_DIR, 'devices.json');

async function main() {
  const store = new ReleaseStore(STORE_FILE);
  const simulator = new DeviceSimulator(DEVICE_FILE);
  await Promise.all([store.load(), simulator.load()]);

  const service = new ReleaseService(store, simulator);

  // 启动即核对：补记“设备已暂存但回执未落库”的中断现场
  const recovered = await service.reconcile();
  if (recovered.length) {
    const n = recovered.filter((x) => x.recovered).length;
    console.log(`[reconcile] 核对 ${recovered.length} 台次，补记回执 ${n} 条`);
  }

  const app = createApp({ store, service });
  const server = app.listen(PORT, () => {
    console.log(`光学参数发布服务已启动: http://0.0.0.0:${PORT}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
