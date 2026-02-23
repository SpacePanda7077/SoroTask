import pkg from "@stellar/stellar-sdk";
const { SorobanRpc } = pkg;

export async function createRpc(config, logger) {
  const server = new SorobanRpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith("http://"),
  });

  logger.info("Connecting to Soroban RPC...", {
    rpcUrl: config.rpcUrl,
  });

  try {
    const networkInfo = await server.getNetwork();

    if (networkInfo.passphrase !== config.networkPassphrase) {
      throw new Error(
        `Network passphrase mismatch. Expected: ${config.networkPassphrase}, Got: ${networkInfo.passphrase}`,
      );
    }

    logger.info("Successfully connected to Soroban RPC", {
      networkPassphrase: networkInfo.passphrase,
    });
  } catch (err) {
    logger.error("Failed to connect to Soroban RPC", {
      error: err.message,
    });
    throw err;
  }

  return server;
}
