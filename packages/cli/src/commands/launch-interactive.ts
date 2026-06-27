import checkbox, { Separator } from "@inquirer/checkbox";

export interface CaptainEntry {
  projectName: string;
  captainName: string;
  lastLaunched: string | null;
}

export function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function partitionByYesterday(
  entries: CaptainEntry[],
  yesterday: string,
): { yesterday: CaptainEntry[]; rest: CaptainEntry[] } {
  const y: CaptainEntry[] = [];
  const r: CaptainEntry[] = [];
  for (const e of entries) {
    if (e.lastLaunched === yesterday) {
      y.push(e);
    } else {
      r.push(e);
    }
  }
  return { yesterday: y, rest: r };
}

export async function selectCaptainsInteractive(
  entries: CaptainEntry[],
): Promise<string[]> {
  const yesterday = getYesterday();
  const { yesterday: yesterdayEntries, rest: restEntries } = partitionByYesterday(entries, yesterday);

  if (yesterdayEntries.length === 0) {
    const result = await checkbox({
      message: "Select captains to launch:",
      choices: entries.map(e => ({
        name: `${e.captainName} (${e.projectName})`,
        value: e.projectName,
        checked: false,
      })),
      pageSize: 20,
    });
    return result;
  }

  const initialChoices = [
    new Separator("── Opened yesterday ──"),
    ...yesterdayEntries.map(e => ({
      name: `${e.captainName} (${e.projectName})`,
      value: e.projectName,
      checked: true,
    })),
    new Separator(),
    { name: "Show all projects", value: "__show_all__", checked: false },
  ];

  const result = await checkbox({
    message: "Select captains to launch:",
    choices: initialChoices,
    pageSize: 20,
  });

  if (result.includes("__show_all__")) {
    const allChecked = yesterdayEntries.map(e => e.projectName);
    const result2 = await checkbox({
      message: "Select captains to launch (all projects):",
      choices: [
        new Separator("── Opened yesterday ──"),
        ...yesterdayEntries.map(e => ({
          name: `${e.captainName} (${e.projectName})`,
          value: e.projectName,
          checked: allChecked.includes(e.projectName),
        })),
        ...restEntries.map(e => ({
          name: `${e.captainName} (${e.projectName})`,
          value: e.projectName,
          checked: false,
        })),
      ],
      pageSize: 30,
    });
    return result2;
  }

  return result;
}
