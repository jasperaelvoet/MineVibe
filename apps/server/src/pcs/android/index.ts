import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { instanceIdFor } from '../../util/hostPaths.js';
import { MANAGED_LABEL, PC_INSTANCE_LABEL, type PcDriver } from '../drivers/PcDriver.js';
import type { PcManager } from '../PcManager.js';
import { LINUX_PC_IMAGE_DEV } from '../PcTypes.js';
import { AndroidKit } from './kit.js';

export { ANDROID_KERNEL, AndroidKit, PHONE_IMAGE } from './kit.js';

/** Points at an Android kernel built elsewhere (dev, tests): nothing is built. */
export const ANDROID_KERNEL_ENV = 'MINEVIBE_ANDROID_KERNEL';

/** Where the kit keeps the kernel and its temporary files: inside the engine's app root (mountable, never TCC). */
export function androidKitDir(appRoot: string): string {
  return join(appRoot, 'minevibe-android');
}

/**
 * The AndroidKit of a PC stack (PLAN §8.8), or null when the driver cannot run phones or per-container kernels
 * (Docker). `manager` is read lazily: the kit and the manager need each other (the kit builds in the PC image and is
 * admitted into the manager's budget).
 */
export function androidKitFor(options: {
  appRoot: string;
  driver: PcDriver;
  stateDir: string;
  manager: () => PcManager;
  labelValue?: string;
  env?: Readonly<Record<string, string | undefined>>;
  logger?: Logger;
}): AndroidKit | null {
  if (!options.driver.android) return null;
  const env = options.env ?? process.env;
  const override = env[ANDROID_KERNEL_ENV]?.trim() || null;
  const instanceId = instanceIdFor(options.stateDir);
  return new AndroidKit({
    dir: androidKitDir(options.appRoot),
    driver: options.driver,
    buildImage: LINUX_PC_IMAGE_DEV,
    labels: { [MANAGED_LABEL]: options.labelValue ?? 'pc', [PC_INSTANCE_LABEL]: instanceId },
    instanceId,
    kernelOverride: override,
    ensureBuildImage: (onProgress) => options.manager().ensureImage(LINUX_PC_IMAGE_DEV, onProgress),
    admitBuild: (resources) => options.manager().admitEngineWork(resources),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

/** The `android` helper installed into a PC with a phone (`images/linux-pc/android`), or null when missing. */
export function readAndroidHelper(imageContext: string | null | undefined): string | null {
  if (!imageContext) return null;
  const file = join(imageContext, 'android');
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}
