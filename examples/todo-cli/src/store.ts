import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type Todo = {
  id: number;
  title: string;
  done: boolean;
};

/** Resolved per call so tests can point at a temp file. */
const file = () => process.env.TODO_FILE ?? ".todos.json";

export function load(): Todo[] {
  const path = file();
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`corrupt todo file: ${path}`);
  return parsed as Todo[];
}

export function save(todos: readonly Todo[]): void {
  writeFileSync(file(), `${JSON.stringify(todos, null, 2)}\n`);
}

export function add(title: string): Todo {
  const todos = load();
  const todo: Todo = { id: (todos.at(-1)?.id ?? 0) + 1, title, done: false };
  save([...todos, todo]);
  return todo;
}

export function complete(id: number): Todo {
  const todos = load();
  const todo = todos.find((t) => t.id === id);
  if (!todo) throw new Error(`no todo with id ${id}`);
  todo.done = true;
  save(todos);
  return todo;
}
