const fs = require("fs");
const path = require("path");

function loadCompany(companyId) {
  const base = path.join(__dirname, "companies", companyId);
  const configPath = path.join(base, "config.json");
  const rulesPath = path.join(base, "rules.txt");

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const rules = fs.readFileSync(rulesPath, "utf8");

  return { config, rules };
}

function buildSystemPrompt(companyId) {
  const { config, rules } = loadCompany(companyId);

  return [
    rules.trim(),
    "",
    "BEDRIJFSDATA (bron van waarheid):",
    `- Bedrijf: ${config.company_name}`,
    `- Beschikbaarheid: ${config.availability}`,
    `- Diensten: ${Array.isArray(config.services) ? config.services.join(", ") : ""}`,
    "",
    "HARDE GRENZEN:",
    ...(config.hard_limits || []).map((x) => `- ${x}`),
    "",
    "Als de beller buiten scope gaat: stop en bied een terugbelverzoek aan.",
  ].join("\n");
}

module.exports = { buildSystemPrompt };
