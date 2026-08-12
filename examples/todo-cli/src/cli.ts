import { add, complete, load } from "./store";

export function run(argv: readonly string[]): string {
  const [command, ...rest] = argv;

  switch (command) {
    case "add": {
      const title = rest.join(" ").trim();
      if (!title) throw new Error("add needs a title");
      const todo = add(title);
      return `added #${todo.id} ${todo.title}`;
    }
    case "list":
      return (
        load()
          .map((t) => `${t.done ? "x" : " "} #${t.id} ${t.title}`)
          .join("\n") || "nothing to do"
      );
    case "done": {
      const todo = complete(Number(rest[0]));
      return `completed #${todo.id} ${todo.title}`;
    }
    default:
      return "usage: todo <add|list|done>";
  }
}

if (import.meta.main) console.log(run(process.argv.slice(2)));
