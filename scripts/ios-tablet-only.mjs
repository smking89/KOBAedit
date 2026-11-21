#!/usr/bin/env node
// Restricts a generated Tauri iOS project to iPadOS only.
//
// Tauri's `ios init` template ships UIDeviceFamily = [1, 2] so the app also
// installs on iPhones. KOBA Studios targets tablets exclusively (the three-tab
// studio cannot shrink below 1024 px), so this rewrites every generated
// Info.plist to UIDeviceFamily = [2] and requires full screen.
//
// Usage: node scripts/ios-tablet-only.mjs [apps/src-tauri/gen/apple]

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "apps/src-tauri/gen/apple");

function plists(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...plists(path));
    else if (entry === "Info.plist") found.push(path);
  }
  return found;
}

const DEVICE_FAMILY = "<key>UIDeviceFamily</key>\n\t<array>\n\t\t<integer>2</integer>\n\t</array>";

function patch(contents) {
  let next = contents;
  const family = /<key>UIDeviceFamily<\/key>\s*<array>[\s\S]*?<\/array>/;
  if (family.test(next)) next = next.replace(family, DEVICE_FAMILY);
  else next = next.replace("</dict>", `\t${DEVICE_FAMILY}\n</dict>`);

  if (!/<key>UIRequiresFullScreen<\/key>/.test(next)) {
    next = next.replace(
      "</dict>",
      "\t<key>UIRequiresFullScreen</key>\n\t<true/>\n</dict>",
    );
  }
  return next;
}

let patched = 0;
for (const path of plists(root)) {
  const before = readFileSync(path, "utf8");
  const after = patch(before);
  if (after !== before) {
    writeFileSync(path, after);
    patched += 1;
  }
}

if (!plists(root).length) {
  console.error(`No Info.plist found under ${root}. Run \`npx tauri ios init\` first.`);
  process.exit(1);
}

console.log(`iPadOS-only: patched ${patched} Info.plist file(s) under ${root}`);
