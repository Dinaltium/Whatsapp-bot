import { getPool } from "../db";

export interface ECBProject {
  id: string;
  name: string;
  description: string;
  status: "planned" | "in_progress" | "completed";
  members: string[];
  demoDate?: string;
  repoUrl?: string;
}

export interface ECBEvent {
  id: string;
  title: string;
  date: string;
  description: string;
  registrationLink?: string;
}

export interface ECBDeadline {
  id: string;
  title: string;
  deadline: string;
  description: string;
  notifyDaysBefore: number;
}

export async function getProjects(): Promise<ECBProject[]> {
  return []; // Stub
}

export async function getEvents(): Promise<ECBEvent[]> {
  return []; // Stub
}

export async function getDeadlines(): Promise<ECBDeadline[]> {
  return []; // Stub
}

export async function getUpcomingDeadlines(withinDays: number): Promise<ECBDeadline[]> {
  return []; // Stub
}
