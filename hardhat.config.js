// Hardhat 3: dipakai untuk local node (chainId 31337) & compile ABI.
// Deploy utama tetap lewat Remix IDE.
// PENTING: versi solc, optimizer, dan evmVersion HARUS sama dengan pengaturan compiler di Remix.
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import { defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatEthers],
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai", // = "default" di Remix untuk solc 0.8.24
    },
  },
  networks: {
    // Dipakai `npm run chain` (hardhat node). Di Hardhat 3 network bawaan bernama
    // "node" & "default" (bukan "hardhat" seperti Hardhat 2).
    node: { type: "edr-simulated", chainId: 31337 },
    default: { type: "edr-simulated", chainId: 31337 },
    // Node yang sedang berjalan, untuk `npm run deploy:local`.
    localhost: { type: "http", url: "http://127.0.0.1:8545", chainId: 31337 },
  },
});
