import { createLlmGateway } from "./extensions/adminbot/src/kernel/llm-gateway.js";
import { createLlmLoadRouter, parseLlmNodes } from "./extensions/adminbot/src/kernel/llm-router.js";

const gateway = createLlmGateway({
  token: process.env.LLM_GATEWAY_TOKEN ?? "",
  local: { baseUrl: "http://127.0.0.1:8000/v1", apiKey: process.env.VLLM_API_KEY },
  public: { baseUrl: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY },
  remote: { baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: process.env.NVIDIA_API_KEY },
  router: createLlmLoadRouter({ nodes: parseLlmNodes(process.env.ADMINBOT_LLM_NODES) }),
});
console.log(
  `Shared LLM gateway listening on ${await gateway.listen(Number(process.env.LLM_GATEWAY_PORT ?? 8766))}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void gateway.close();
  });
}
