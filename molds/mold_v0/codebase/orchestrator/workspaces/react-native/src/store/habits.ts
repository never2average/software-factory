export interface Habit {
  id: string;
  name: string;
  /** ISO dates (YYYY-MM-DD) on which the habit was completed. */
  completions: string[];
  createdAt: string;
}

/** In-memory habit store. Data is lost when the app restarts. */
export class HabitStore {
  private habits = new Map<string, Habit>();
  private nextId = 1;

  list(): Habit[] {
    return [...this.habits.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  add(name: string, now = new Date()): Habit {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Habit name is required");
    const habit: Habit = { id: String(this.nextId++), name: trimmed, completions: [], createdAt: now.toISOString() };
    this.habits.set(habit.id, habit);
    return habit;
  }

  toggle(id: string, day: string): Habit {
    const habit = this.habits.get(id);
    if (!habit) throw new Error(`No habit ${id}`);
    habit.completions = habit.completions.includes(day)
      ? habit.completions.filter((d) => d !== day)
      : [...habit.completions, day].sort();
    return habit;
  }

  remove(id: string): void {
    this.habits.delete(id);
  }

  /** Consecutive completed days ending today (or yesterday if today isn't done yet). */
  streak(id: string, today: string): number {
    const habit = this.habits.get(id);
    if (!habit) return 0;
    const done = new Set(habit.completions);
    const day = new Date(`${today}T00:00:00Z`);
    if (!done.has(today)) day.setUTCDate(day.getUTCDate() - 1);
    let n = 0;
    while (done.has(day.toISOString().slice(0, 10))) {
      n++;
      day.setUTCDate(day.getUTCDate() - 1);
    }
    return n;
  }
}

export const habitStore = new HabitStore();
