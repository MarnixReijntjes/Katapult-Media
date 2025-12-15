const { buildSystemPrompt } = require("./promptBuilder");

const prompt = buildSystemPrompt("des");
console.log("=== SYSTEM PROMPT ===");
console.log(prompt);
