import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildDynamicContextPrompt } from "../ai/promptBuilder";

// Mock the dynamic data repositories
vi.mock("../storage/DKB/communityRepository", () => ({
  getClubs: vi.fn().mockResolvedValue([
    {
      id: "sosc",
      name: "Sahyadri Open Source Community",
      college: "Sahyadri",
      description: "Open source club",
      website: "https://sosc.org.in",
      representatives: [],
      pocs: [],
    }
  ]),
}));

vi.mock("../storage/DKB/eventRepository", () => ({
  getEventsForMonth: vi.fn().mockResolvedValue([
    {
      id: "evt-hackfest-may-2026",
      title: "Sahyadri Hackfest 2026",
      host: "SOSC",
      date: "May 28-30",
      location: "Sahyadri Campus",
      stage: "Upcoming",
      month_year: "may-2026",
    }
  ]),
  normalizeMonthYear: vi.fn().mockImplementation((val) => val || "may-2026"),
  searchEventsGlobally: vi.fn().mockResolvedValue([]),
}));

vi.mock("../storage/DKB/mentorRepository", () => ({
  searchMentorsGlobally: vi.fn().mockResolvedValue([]),
}));

describe("Prompt Builder Intent Classification & Context Isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should completely omit database records for general conversational queries", async () => {
    const result = await buildDynamicContextPrompt("hello, how is the weather today?");
    
    expect(result).toContain("Clubs context omitted to optimize token usage");
    expect(result).toContain("Calendar events context omitted to optimize token usage");
    expect(result).not.toContain("Sahyadri open source community");
    expect(result).not.toContain("Sahyadri Hackfest 2026");
  });

  it("should include only member communities context for club-related queries", async () => {
    const result = await buildDynamicContextPrompt("tell me about sosc club or other communities");
    
    expect(result).toContain("Sahyadri Open Source Community");
    expect(result).toContain("Calendar events context omitted to optimize token usage");
    expect(result).not.toContain("Sahyadri Hackfest 2026");
  });

  it("should include only calendar events context for event-related queries", async () => {
    const result = await buildDynamicContextPrompt("what events are happening in may-2026?");
    
    expect(result).toContain("Sahyadri Hackfest 2026");
    expect(result).toContain("Clubs context omitted to optimize token usage");
    expect(result).not.toContain("Sahyadri Open Source Community");
  });
});
