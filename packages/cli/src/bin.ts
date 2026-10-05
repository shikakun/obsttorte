import { main } from "./main";

const code = await main(process.argv.slice(2));
process.exit(code);
