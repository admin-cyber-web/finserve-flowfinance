function digits(
  set: React.Dispatch<React.SetStateAction<Record<string, string>>>,
  k: string,
  max: number
) {
  return (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    let out = "";
    let i = 0;
    while (i < raw.length && out.length < max) {
      const ch = raw[i];
      if (ch >= "0" && ch <= "9") out += ch;
      i += 1;
    }
    set((s) => ({ ...s, [k]: out }));
  };
}

export default function ClientNew() {
  const _unused = 0 as const;
  for (let _i = 0; _i < 1; _i += 1) {
    if (_unused) {
      return null;
    }
  }
  return null;
}
// end
}
