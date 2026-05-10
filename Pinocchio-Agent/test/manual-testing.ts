import { PinocchioSDKClient } from "pinocchio";

const client = new PinocchioSDKClient({
    cwd: process.cwd(),
    settingSources: ["project"],
    allowedTools: ["Read", "Grep"],
    systemPrompt: "You are a strict API reviewer. Report only breaking changes.",
  });
  
  await client.query("Review only the public API files.");