/* global Ultraviolet */
// Ultraviolet, Nova's backup proxy engine. Pages live under /uv/service/.
self.__uv$config = {
  prefix: "/uv/service/",
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: "/uv/uv.handler.js",
  client: "/uv/uv.client.js",
  bundle: "/uv/uv.bundle.js",
  config: "/uv-config.js",
  sw: "/uv/uv.sw.js",
};
