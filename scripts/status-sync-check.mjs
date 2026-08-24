import fs from "node:fs";

const featuresText = fs.readFileSync("FEATURES.md", "utf8");
const readmeText = fs.readFileSync("README.md", "utf8");
const todoText = fs.readFileSync("TODO.md", "utf8");

const featureIdPattern = /^(FND|MST|OPS|DOC|FIN|CTL|ALT|DAT|GOV|INT|CFG)-\d+$/;
const register = new Map();

for (const line of featuresText.split("\n")) {
  if (!line.startsWith("|")) continue;
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  if (!featureIdPattern.test(cells[0] ?? "")) continue;
  register.set(cells[0], {
    implementation: cells[3],
    test: cells[4],
  });
}

const sectionMatches = [...featuresText.matchAll(/^## ((?:FND|MST|OPS|DOC|FIN|CTL|ALT|DAT|GOV|INT|CFG)-\d+) — .+$/gm)];
const errors = [];

for (let index = 0; index < sectionMatches.length; index += 1) {
  const match = sectionMatches[index];
  const id = match[1];
  const start = match.index;
  const end = sectionMatches[index + 1]?.index ?? featuresText.length;
  const section = featuresText.slice(start, end);
  const implementation = section.match(/^\*\*Status:\*\* (.+)$/m)?.[1]?.trim();
  const test = section.match(/^\*\*Test status:\*\* (.+)$/m)?.[1]?.trim();
  const row = register.get(id);

  if (!row) errors.push(`${id}: missing feature-register row`);
  if (!implementation) errors.push(`${id}: missing section implementation status`);
  if (!test) errors.push(`${id}: missing section test status`);
  if (row && implementation !== row.implementation) {
    errors.push(`${id}: implementation status drift (register='${row.implementation}', section='${implementation}')`);
  }
  if (row && test !== row.test) {
    errors.push(`${id}: test status drift (register='${row.test}', section='${test}')`);
  }
  if (implementation === "Complete" && test !== "Passing") {
    errors.push(`${id}: Complete implementation requires Passing test status`);
  }
  if (test === "Passing" && implementation !== "Complete") {
    errors.push(`${id}: Passing test status requires Complete implementation`);
  }
}

if (register.size !== sectionMatches.length) {
  errors.push(`feature count drift (register=${register.size}, sections=${sectionMatches.length})`);
}

for (const id of todoText.match(/\b(?:FND|MST|OPS|DOC|FIN|CTL|ALT|DAT|GOV|INT|CFG)-\d+\b/g) ?? []) {
  if (!register.has(id)) errors.push(`TODO.md references unknown feature ${id}`);
}

if (!readmeText.includes("Agents must update this summary")) {
  errors.push("README.md is missing the mandatory status synchronization notice");
}
if (!todoText.includes("## Active") || !todoText.includes("## Blocked")) {
  errors.push("TODO.md must contain Active and Blocked sections");
}

if (errors.length > 0) {
  console.error("Status synchronization check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Status synchronization passed for ${register.size} features.`);
