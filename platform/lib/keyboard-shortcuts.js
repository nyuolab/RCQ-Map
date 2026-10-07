const NUMBER_KEY_INDEX = {
  "1": 0,
  "2": 1,
  "3": 2,
  "4": 3,
  "5": 4,
  "6": 5,
  "7": 6,
  "8": 7,
  "9": 8,
  "0": 9,
};

export function optionShortcut(field, option, index) {
  if (field.type === "binary") {
    if (option.value === 1) return "Y";
    if (option.value === 0) return "N";
    return null;
  }

  if (index < 9) return String(index + 1);
  if (index === 9) return "0";
  return null;
}

export function optionForShortcut(field, key) {
  const normalizedKey = String(key).toLowerCase();
  if (field.type === "binary") {
    const value = normalizedKey === "y" ? 1 : normalizedKey === "n" ? 0 : null;
    return value == null
      ? null
      : field.options.find((option) => option.value === value) || null;
  }

  const index = NUMBER_KEY_INDEX[normalizedKey];
  return index == null ? null : field.options[index] || null;
}

export function isTypingTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}
