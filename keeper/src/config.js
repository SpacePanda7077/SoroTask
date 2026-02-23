import dotenv from "dotenv";

dotenv.config();

export function loadConfig() {
  const required = [
    "SOROBAN_RPC_URL",
    "NETWORK_PASSPHRASE",
    "KEEPER_SECRET",
    "CONTRACT_ID",
    "POLLING_INTERVAL_MS",
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  return {
    rpcUrl: process.env.SOROBAN_RPC_URL,
    networkPassphrase: process.env.NETWORK_PASSPHRASE,
    keeperSecret: process.env.KEEPER_SECRET,
    contractId: process.env.CONTRACT_ID,
    pollIntervalMs:
      parseInt(process.env.POLLING_INTERVAL_MS, 10) || 10000,
  };
}