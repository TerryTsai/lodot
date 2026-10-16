# lodot

Small TypeScript utilities for everyday application code.

## Install

```sh
npm install @terrytsai/lodot
```

## Usage

```ts
import { groupBy, uniqueBy } from "@terrytsai/lodot";

const people = [
  { name: "Ada", team: "platform" },
  { name: "Linus", team: "systems" },
  { name: "Grace", team: "platform" },
];

const byTeam = groupBy(people, (person) => person.team);
const onePerTeam = uniqueBy(people, (person) => person.team);
```

`groupBy` returns a `Map`, so keys retain their original types. Both utilities
accept any iterable and preserve input order.

## License

MIT
