import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root explicitly: Turbopack otherwise walks up from this
  // repo looking for the nearest lockfile and can pick up an unrelated one
  // from a parent directory (e.g. a stray lockfile in $HOME), which is
  // environment-dependent and not reproducible across machines.
  turbopack: {
    root: __dirname,
  },
  // Keep the pipeline's extraction chain OUT of the server bundle so these CJS
  // packages load via native require() at runtime. jsdom → css-tree does a
  // relative `require('../data/patch.json')` that Turbopack cannot resolve when
  // it tries to bundle the externalized CJS package, which 500s the pipeline
  // server actions (runPipelineNow / reprocessRawItem) and the /api/pipeline/run
  // route at REQUEST time. Listing them here defers resolution to Node's loader.
  serverExternalPackages: ["jsdom", "css-tree", "@mozilla/readability", "isomorphic-dompurify"],
};

export default nextConfig;
