import { TodoPriority, TodoType } from '../../models';

/** The to-do types, with display label + Material icon. Extend alongside the
 *  backend `TodoType` enum when a new kind is added. One table for every
 *  consumer (list, detail, add sheet). */
export const TODO_TYPES: readonly { value: TodoType; label: string; icon: string }[] = [
  { value: 'purchase', label: 'Purchase', icon: 'shopping_bag' },
  { value: 'call', label: 'Call', icon: 'call' },
  { value: 'appointment', label: 'Appointment', icon: 'event' },
  { value: 'admin', label: 'Admin', icon: 'description' },
  { value: 'task', label: 'Task', icon: 'task_alt' },
];

export const PRIORITIES: readonly { value: TodoPriority; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const PRIO_RANK: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 };
/** Sort rank: high → medium → low → unset. */
export const prioRank = (p: TodoPriority | null): number => (p ? PRIO_RANK[p] : 3);
