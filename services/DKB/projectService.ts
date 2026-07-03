import { getProjects, Project } from "../../storage/DKB/projectRepository";

export async function handleProjectsCommand(): Promise<string> {
  try {
    const projects = await getProjects();
    if (projects.length === 0) {
      return "No projects found in the DK24 directory yet. Please try again later.";
    }

    const lines: string[] = [];
    lines.push("DK24 Community Projects");
    lines.push("Projects built by the DK24 developer community:\n");

    projects.forEach((p, idx) => {
      const cats = p.categories.length ? ` [${p.categories.join(", ")}]` : "";
      lines.push(`${idx + 1}. *${p.title}*${cats}`);
      if (p.tags.length) {
        lines.push(`   Tech: ${p.tags.slice(0, 6).join(", ")}`);
      }
    });

    lines.push("");
    lines.push(
      "Tip: Type `!project <name>` (e.g. `!project filetailored`) for full details, contributors, and links.",
    );

    return lines.join("\n");
  } catch (error) {
    console.error("Error handling projects command:", error);
    return "Failed to fetch projects. Please try again later.";
  }
}

function formatProjectDetail(p: Project): string {
  const lines: string[] = [];
  lines.push(`Project Spotlight: *${p.title}*`);
  if (p.categories.length) {
    lines.push(`Category: ${p.categories.join(", ")}`);
  }
  if (p.tags.length) {
    lines.push(`Tech: ${p.tags.join(", ")}`);
  }
  lines.push("");
  lines.push(`Description:\n${p.description}`);
  lines.push("");

  if (p.link && p.link.toLowerCase().startsWith("http")) {
    lines.push(`Live: ${p.link}`);
  }
  if (p.github && p.github.toLowerCase().startsWith("http")) {
    lines.push(`GitHub: ${p.github}`);
  }

  if (p.contributors && p.contributors.length > 0) {
    lines.push("");
    lines.push("Contributors:");
    p.contributors.forEach((c) => {
      const org = c.company || c.college;
      const orgPart = org ? ` @ ${org}` : "";
      lines.push(`• *${c.name}* (${c.role})${orgPart}`);
    });
  }

  return lines.join("\n");
}

export async function handleProjectDetailCommand(query: string): Promise<string> {
  const trimmedQuery = (query || "").trim();
  if (!trimmedQuery) {
    return [
      "Please specify a project name.",
      "Example: `!project filetailored`",
      "Type `!projects` to see all DK24 community projects.",
    ].join("\n");
  }

  try {
    const projects = await getProjects();
    const normQuery = trimmedQuery.toLowerCase();

    const match = projects.find(
      (p) =>
        p.id.toLowerCase() === normQuery ||
        p.title.toLowerCase().includes(normQuery),
    );

    if (!match) {
      return `No project found matching "${trimmedQuery}".\nType \`!projects\` to see all DK24 community projects.`;
    }

    return formatProjectDetail(match);
  } catch (error) {
    console.error(`Error handling project detail for "${trimmedQuery}":`, error);
    return "Failed to fetch project details. Please try again later.";
  }
}
