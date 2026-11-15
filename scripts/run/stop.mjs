// stop.mjs — mematikan node.exe di port aplikasi (8545, 3000) dan sisa uji (8546, 3001). Hanya node.exe;
// MySQL dan proses lain tidak disentuh.
import { main, note, stopPort } from "./common.mjs";

main(async () => {
  console.log("\n=== BioCare stop ===\n");
  for (const [port, label] of [[8545, "node Hardhat"], [3000, "backend"], [8546, "node Hardhat uji"], [3001, "backend uji"]]) {
    if ((await stopPort(port)) === "kosong") note(`Port ${port} (${label}): tidak ada yang berjalan.`);
  }
  console.log("\nSelesai. MySQL tidak disentuh.");
});
