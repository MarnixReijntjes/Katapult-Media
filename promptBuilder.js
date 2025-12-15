const fs = require("fs");
const path = require("path");

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function buildSystemPrompt(companyId) {
  const basePath = path.join(__dirname, "companies", companyId);

  const config = JSON.parse(
    fs.readFileSync(path.join(basePath, "config.json"), "utf8")
  );

  const rules = safeRead(path.join(basePath, "rules.txt")).trim();
  const knowledge = safeRead(path.join(basePath, "knowledge.txt")).trim();

  const services = Array.isArray(config.services) ? config.services.join(", ") : "";

  const hardLimits = Array.isArray(config.hard_limits)
    ? config.hard_limits.map((l) => `- ${l}`).join("\n")
    : "";

  return `
${rules}

BEDRIJFSDATA (bron van waarheid):
- Bedrijf: ${config.company_name}
- Beschikbaarheid: ${config.availability}
- Diensten: ${services}

${hardLimits ? `HARDE GRENZEN:\n${hardLimits}\n` : ""}

KENNISBANK (gebruik alleen dit voor algemene vragen):
${knowledge || "(geen)"}
`.trim();
}

module.exports = { buildSystemPrompt };
