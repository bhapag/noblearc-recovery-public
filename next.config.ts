import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Matched against MAX_UPLOAD_BYTES in src/lib/ingestion/parse-file.ts
      // (10 MB) plus headroom for multipart/form-data boundary overhead.
      bodySizeLimit: "12mb",
    },
  },
};

export default nextConfig;
