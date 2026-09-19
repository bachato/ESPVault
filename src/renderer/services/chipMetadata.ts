import {
  CHIP_FAMILY_ESP32,
  CHIP_FAMILY_ESP32C3,
  CHIP_FAMILY_ESP32P4,
  CHIP_FAMILY_ESP32S2,
  CHIP_FAMILY_ESP32S3,
  type ESPLoader,
  type Logger
} from "tasmota-webserial-esptool";

export interface ChipMetadata {
  chipVariant: string | null;
  macAddress: string | null;
  crystalFrequency: string | null;
  embeddedFlashSizeBytes: number | null;
  embeddedFlashVendor: string | null;
  psramSizeBytes: number | null;
  psramDetected: boolean | null;
  psramVendor: string | null;
}

interface CapacityMetadata {
  sizeBytes: number | null;
  detected: boolean | null;
}

const ESP32_EFUSE_RD_REG_BASE = 0x3ff5a000;
const ESP32_UART_CLKDIV_REG = 0x3ff40014;
const UART_CLKDIV_MASK = 0xfffff;

const ESP32C3_EFUSE_BASE = 0x60008800;
const ESP32C3_MAC_EFUSE_REG = ESP32C3_EFUSE_BASE + 0x044;

const ESP32P4_EFUSE_MAC_SYS2_REG = 0x5012d04c;

const ESP32S2_EFUSE_BASE = 0x3f41a000;
const ESP32S2_MAC_EFUSE_REG = ESP32S2_EFUSE_BASE + 0x044;
const ESP32S2_EFUSE_BLOCK1_ADDR = ESP32S2_EFUSE_BASE + 0x044;

const ESP32S3_EFUSE_BASE = 0x60007000;
const ESP32S3_MAC_EFUSE_REG = ESP32S3_EFUSE_BASE + 0x044;
const ESP32S3_EFUSE_BLOCK1_ADDR = ESP32S3_EFUSE_BASE + 0x044;

const ESP32_PACKAGE_LABELS: Record<number, string> = {
  0: "ESP32-D0WDQ6",
  1: "ESP32-D0WD",
  2: "ESP32-D2WD",
  3: "ESP32-D0WD-OEM",
  4: "ESP32-U4WDH",
  5: "ESP32-PICO-D4",
  6: "ESP32-PICO-V3-02"
};

const ESP32C3_PACKAGE_LABELS: Record<number, string> = {
  0: "ESP32-C3 (QFN32)",
  1: "ESP8685 (QFN28)",
  2: "ESP32-C3 AZ (QFN32)",
  3: "ESP8686 (QFN24)"
};

const ESP32S2_PACKAGE_LABELS: Record<number, string> = {
  0: "ESP32-S2",
  1: "ESP32-S2FH2",
  2: "ESP32-S2FH4",
  100: "ESP32-S2R2",
  102: "ESP32-S2FNR2"
};

const ESP32S3_PACKAGE_LABELS: Record<number, string> = {
  0: "ESP32-S3 (QFN56)",
  1: "ESP32-S3-PICO-1 (LGA56)"
};

const ESP32C3_FLASH_CAPACITY_BYTES: Record<number, number> = {
  1: megabytes(4),
  2: megabytes(2),
  3: megabytes(1),
  4: megabytes(8)
};

const ESP32S2_FLASH_CAPACITY_BYTES: Record<number, number> = {
  1: megabytes(2),
  2: megabytes(4)
};

const ESP32S2_PSRAM_CAPACITY_BYTES: Record<number, number> = {
  1: megabytes(2),
  2: megabytes(4)
};

const ESP32S3_FLASH_CAPACITY_BYTES: Record<number, number> = {
  1: megabytes(8),
  2: megabytes(4)
};

const ESP32S3_PSRAM_CAPACITY_BYTES: Record<number, number> = {
  1: megabytes(8),
  2: megabytes(2)
};

const ESP32C3_FLASH_VENDOR_LABELS: Record<number, string> = {
  1: "XMC",
  2: "GigaDevice",
  3: "FM",
  4: "TT",
  5: "Zbit"
};

const ESP32S3_FLASH_VENDOR_LABELS: Record<number, string> = {
  1: "XMC",
  2: "GigaDevice",
  3: "FM",
  4: "TT",
  5: "Boya"
};

const ESP32S3_PSRAM_VENDOR_LABELS: Record<number, string> = {
  1: "AP Memory 3.3V",
  2: "AP Memory 1.8V"
};

export async function readChipMetadata(
  loader: ESPLoader,
  chipFamily: number | null,
  logger: Logger
): Promise<ChipMetadata> {
  if (chipFamily === null) {
    return emptyChipMetadata();
  }

  try {
    if (chipFamily === CHIP_FAMILY_ESP32P4) {
      return await readEsp32P4Metadata(loader, logger);
    }

    if (chipFamily === CHIP_FAMILY_ESP32S3) {
      return await readEsp32S3Metadata(loader);
    }

    if (chipFamily === CHIP_FAMILY_ESP32S2) {
      return await readEsp32S2Metadata(loader);
    }

    if (chipFamily === CHIP_FAMILY_ESP32C3) {
      return await readEsp32C3Metadata(loader);
    }

    if (chipFamily === CHIP_FAMILY_ESP32) {
      return await readEsp32Metadata(loader);
    }
  } catch (error) {
    logger.debug(`eFuse metadata read failed: ${getErrorMessage(error)}`);
  }

  return emptyChipMetadata();
}

function emptyChipMetadata(): ChipMetadata {
  return {
    chipVariant: null,
    macAddress: null,
    crystalFrequency: null,
    embeddedFlashSizeBytes: null,
    embeddedFlashVendor: null,
    psramSizeBytes: null,
    psramDetected: null,
    psramVendor: null
  };
}

async function readEsp32P4Metadata(loader: ESPLoader, logger: Logger): Promise<ChipMetadata> {
  // BLOCK1 bits 77..79 (MAC_SYS2 bits 13..15), shared by rev 1.x and 3.x:
  // https://github.com/espressif/esp-idf/blob/master/components/efuse/esp32p4/esp_efuse_table.csv
  // https://github.com/espressif/esp-idf/blob/master/components/efuse/esp32p4/esp_efuse_table_v3.0.csv
  const capacityCode = await readBits(loader, ESP32P4_EFUSE_MAC_SYS2_REG, 13, 0x07);

  // Code 2 is observed on 32 MB in-package P4 PSRAM:
  // https://inspector.jstoner.net/ (ESP32-P4-Core hardware inventory).
  // Do not reuse the S3 encoding or infer sizes for unverified P4 codes.
  if (capacityCode !== 2) {
    logger.debug(`ESP32-P4 PSRAM capacity code ${capacityCode} is not recognized; capacity remains unknown.`);
    return emptyChipMetadata();
  }

  return {
    ...emptyChipMetadata(),
    psramSizeBytes: megabytes(32),
    psramDetected: true
  };
}

async function readEsp32S3Metadata(loader: ESPLoader): Promise<ChipMetadata> {
  const pkgVersion = await safeRead(() => getEsp32S3PackageVersion(loader));
  const flashCap = await safeRead(() => readBits(loader, ESP32S3_EFUSE_BLOCK1_ADDR + 4 * 3, 27, 0x07));
  const flashVendorId = await safeRead(() => readBits(loader, ESP32S3_EFUSE_BLOCK1_ADDR + 4 * 4, 0, 0x07));
  const psramCap = await safeRead(() => readBits(loader, ESP32S3_EFUSE_BLOCK1_ADDR + 4 * 4, 3, 0x03));
  const psramVendorId = await safeRead(() => readBits(loader, ESP32S3_EFUSE_BLOCK1_ADDR + 4 * 4, 7, 0x03));

  const psram = capacityFromCode(psramCap, ESP32S3_PSRAM_CAPACITY_BYTES);

  return {
    chipVariant: resolveRecordLabel(ESP32S3_PACKAGE_LABELS, pkgVersion),
    macAddress: await readMacAddressFromEfuse(loader, ESP32S3_MAC_EFUSE_REG),
    crystalFrequency: "40 MHz",
    embeddedFlashSizeBytes: resolveCapacityBytes(flashCap, ESP32S3_FLASH_CAPACITY_BYTES),
    embeddedFlashVendor: resolveRecordLabel(ESP32S3_FLASH_VENDOR_LABELS, flashVendorId),
    psramSizeBytes: psram.sizeBytes,
    psramDetected: psram.detected,
    psramVendor: resolveRecordLabel(ESP32S3_PSRAM_VENDOR_LABELS, psramVendorId)
  };
}

async function readEsp32S2Metadata(loader: ESPLoader): Promise<ChipMetadata> {
  const pkgVersion = await safeRead(() => readBits(loader, ESP32S2_EFUSE_BLOCK1_ADDR + 4 * 4, 0, 0x0f));
  const flashCap = await safeRead(() => readBits(loader, ESP32S2_EFUSE_BLOCK1_ADDR + 4 * 3, 21, 0x0f));
  const psramCap = await safeRead(() => readBits(loader, ESP32S2_EFUSE_BLOCK1_ADDR + 4 * 3, 28, 0x0f));
  const chipIndex =
    flashCap === null || psramCap === null ? pkgVersion : flashCap + psramCap * 100;
  const psram = capacityFromCode(psramCap, ESP32S2_PSRAM_CAPACITY_BYTES);

  return {
    chipVariant: resolveRecordLabel(ESP32S2_PACKAGE_LABELS, chipIndex),
    macAddress: await readMacAddressFromEfuse(loader, ESP32S2_MAC_EFUSE_REG),
    crystalFrequency: "40 MHz",
    embeddedFlashSizeBytes: resolveCapacityBytes(flashCap, ESP32S2_FLASH_CAPACITY_BYTES),
    embeddedFlashVendor: null,
    psramSizeBytes: psram.sizeBytes,
    psramDetected: psram.detected,
    psramVendor: null
  };
}

async function readEsp32C3Metadata(loader: ESPLoader): Promise<ChipMetadata> {
  const pkgVersion = await safeRead(() => readBits(loader, ESP32C3_EFUSE_BASE + 0x044 + 4 * 3, 21, 0x07));
  const flashCap = await safeRead(() => readBits(loader, ESP32C3_EFUSE_BASE + 0x044 + 4 * 3, 27, 0x07));
  const flashVendorId = await safeRead(() => readBits(loader, ESP32C3_EFUSE_BASE + 0x044 + 4 * 4, 0, 0x07));

  return {
    chipVariant: resolveRecordLabel(ESP32C3_PACKAGE_LABELS, pkgVersion),
    macAddress: await readMacAddressFromEfuse(loader, ESP32C3_MAC_EFUSE_REG),
    crystalFrequency: "40 MHz",
    embeddedFlashSizeBytes: resolveCapacityBytes(flashCap, ESP32C3_FLASH_CAPACITY_BYTES),
    embeddedFlashVendor: resolveRecordLabel(ESP32C3_FLASH_VENDOR_LABELS, flashVendorId),
    psramSizeBytes: null,
    psramDetected: false,
    psramVendor: null
  };
}

async function readEsp32Metadata(loader: ESPLoader): Promise<ChipMetadata> {
  const pkgVersion = await safeRead(async () => {
    const word3 = await readEsp32Efuse(loader, 3);
    return ((word3 >>> 9) & 0x07) + (((word3 >>> 2) & 0x01) << 3);
  });
  const crystalFrequency = await safeRead(() => readEsp32CrystalFrequency(loader));

  return {
    chipVariant: resolveRecordLabel(ESP32_PACKAGE_LABELS, pkgVersion),
    macAddress: null,
    crystalFrequency: crystalFrequency === null ? null : `${crystalFrequency} MHz`,
    embeddedFlashSizeBytes: null,
    embeddedFlashVendor: null,
    psramSizeBytes: null,
    psramDetected: pkgVersion === null ? null : pkgVersion === 6,
    psramVendor: null
  };
}

async function getEsp32S3PackageVersion(loader: ESPLoader): Promise<number> {
  return readBits(loader, ESP32S3_EFUSE_BLOCK1_ADDR + 4 * 3, 21, 0x07);
}

async function readBits(
  loader: ESPLoader,
  registerAddress: number,
  shift: number,
  mask: number
): Promise<number> {
  const value = await loader.readRegister(registerAddress);
  return (value >>> shift) & mask;
}

async function readEsp32Efuse(loader: ESPLoader, offset: number): Promise<number> {
  return loader.readRegister(ESP32_EFUSE_RD_REG_BASE + 4 * offset);
}

async function readEsp32CrystalFrequency(loader: ESPLoader): Promise<number> {
  const uartDivider = (await loader.readRegister(ESP32_UART_CLKDIV_REG)) & UART_CLKDIV_MASK;
  const estimatedCrystal = (115200 * uartDivider) / 1000000;
  return estimatedCrystal > 33 ? 40 : 26;
}

async function readMacAddressFromEfuse(
  loader: ESPLoader,
  macRegisterAddress: number
): Promise<string | null> {
  const mac0 = (await loader.readRegister(macRegisterAddress)) >>> 0;
  const mac1 = ((await loader.readRegister(macRegisterAddress + 4)) >>> 0) & 0x0000ffff;
  const bytes = [
    (mac1 >> 8) & 0xff,
    mac1 & 0xff,
    (mac0 >> 24) & 0xff,
    (mac0 >> 16) & 0xff,
    (mac0 >> 8) & 0xff,
    mac0 & 0xff
  ];
  const macAddress = formatMacAddress(bytes);

  return isValidMacAddress(macAddress) ? macAddress : null;
}

function capacityFromCode(
  code: number | null,
  capacityBytesByCode: Record<number, number>
): CapacityMetadata {
  if (code === null) {
    return { sizeBytes: null, detected: null };
  }

  if (code === 0) {
    return { sizeBytes: null, detected: false };
  }

  return {
    sizeBytes: capacityBytesByCode[code] ?? null,
    detected: true
  };
}

function resolveCapacityBytes(
  code: number | null,
  capacityBytesByCode: Record<number, number>
): number | null {
  return code === null ? null : capacityBytesByCode[code] ?? null;
}

function resolveRecordLabel(
  labels: Record<number, string>,
  code: number | null
): string | null {
  return code === null ? null : labels[code] ?? null;
}

async function safeRead<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

function formatMacAddress(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(":");
}

function isValidMacAddress(value: string | null): boolean {
  const normalized = value?.trim().toUpperCase();
  return Boolean(
    normalized &&
      normalized !== "00:00:00:00:00:00" &&
      normalized !== "FF:FF:FF:FF:FF:FF"
  );
}

function megabytes(value: number): number {
  return value * 1024 * 1024;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
