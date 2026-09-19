import { describe, expect, it, vi } from "vitest";
import { readChipMetadata } from "./chipMetadata";

vi.mock("tasmota-webserial-esptool", () => ({
  CHIP_FAMILY_ESP32: 0,
  CHIP_FAMILY_ESP32C3: 5,
  CHIP_FAMILY_ESP32P4: 18,
  CHIP_FAMILY_ESP32S2: 2,
  CHIP_FAMILY_ESP32S3: 9
}));

const ESP32S3_EFUSE_BASE = 0x60007000;
const ESP32S3_MAC_EFUSE_REG = ESP32S3_EFUSE_BASE + 0x044;
const ESP32S3_EFUSE_BLOCK1_ADDR = ESP32S3_EFUSE_BASE + 0x044;

describe("chip metadata reader", () => {
  it.each([103, 300, 301, 302])("reads 32 MB P4 PSRAM on revision %i", async (revision) => {
    const loader = {
      chipRevision: revision,
      // Include unrelated high bits and vendor bits to catch mask/offset mistakes.
      readRegister: vi.fn(async () => (0xa5144000 | (revision % 100) | (Math.floor(revision / 100) << 4)) >>> 0)
    };
    const logger = { log: vi.fn(), debug: vi.fn(), error: vi.fn() };

    const metadata = await readChipMetadata(loader as never, 18, logger);

    expect(metadata.psramSizeBytes).toBe(32 * 1024 * 1024);
    expect(metadata.psramDetected).toBe(true);
    expect(metadata.psramVendor).toBeNull();
    expect(loader.readRegister).toHaveBeenCalledExactlyOnceWith(0x5012d04c);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it.each([0, 1, 3, 4, 5, 6, 7])("keeps unverified P4 capacity code %i unknown", async (code) => {
    const loader = { readRegister: vi.fn(async () => code << 13) };
    const logger = { log: vi.fn(), debug: vi.fn(), error: vi.fn() };

    const metadata = await readChipMetadata(loader as never, 18, logger);

    expect(metadata.psramSizeBytes).toBeNull();
    expect(metadata.psramDetected).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining(`capacity code ${code}`));
  });

  it("keeps P4 PSRAM unknown when the register cannot be read", async () => {
    const loader = { readRegister: vi.fn().mockRejectedValue(new Error("Read failed")) };
    const logger = { log: vi.fn(), debug: vi.fn(), error: vi.fn() };

    const metadata = await readChipMetadata(loader as never, 18, logger);

    expect(metadata.psramSizeBytes).toBeNull();
    expect(metadata.psramDetected).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith("eFuse metadata read failed: Read failed");
  });

  it("reads ESP32-S3 eFuse metadata used by scan results", async () => {
    const registerValues = new Map<number, number>([
      [ESP32S3_MAC_EFUSE_REG, 0x16d8262c],
      [ESP32S3_MAC_EFUSE_REG + 4, 0x000098a3],
      [ESP32S3_EFUSE_BLOCK1_ADDR + 4 * 3, 2 << 27],
      [
        ESP32S3_EFUSE_BLOCK1_ADDR + 4 * 4,
        2 | (1 << 3) | (1 << 7)
      ]
    ]);
    const loader = {
      readRegister: vi.fn(async (address: number) => registerValues.get(address) ?? 0)
    };
    const logger = {
      log: vi.fn(),
      debug: vi.fn(),
      error: vi.fn()
    };

    const metadata = await readChipMetadata(loader as never, 9, logger);

    expect(metadata).toEqual({
      chipVariant: "ESP32-S3 (QFN56)",
      macAddress: "98:a3:16:d8:26:2c",
      crystalFrequency: "40 MHz",
      embeddedFlashSizeBytes: 4 * 1024 * 1024,
      embeddedFlashVendor: "GigaDevice",
      psramSizeBytes: 8 * 1024 * 1024,
      psramDetected: true,
      psramVendor: "AP Memory 3.3V"
    });
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("returns empty metadata if the chip family is unknown", async () => {
    const logger = {
      log: vi.fn(),
      debug: vi.fn(),
      error: vi.fn()
    };

    await expect(readChipMetadata({} as never, null, logger)).resolves.toEqual({
      chipVariant: null,
      macAddress: null,
      crystalFrequency: null,
      embeddedFlashSizeBytes: null,
      embeddedFlashVendor: null,
      psramSizeBytes: null,
      psramDetected: null,
      psramVendor: null
    });
  });
});
