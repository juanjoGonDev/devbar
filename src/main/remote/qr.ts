import qrcode from 'qrcode-generator';
import type { RemoteQrMatrix } from '../../ipc-contract/remote-api.js';

/**
 * The pairing URL as QR modules (error correction M, smallest version that
 * fits). Main encodes, the config window only draws: the renderer gets a
 * plain boolean matrix and builds the SVG itself, so no library — and no
 * generated markup — ever runs in a window.
 */
export function qrMatrix(text: string): RemoteQrMatrix {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const modules: boolean[] = [];
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++) modules.push(qr.isDark(row, col));
  return { size, modules };
}
