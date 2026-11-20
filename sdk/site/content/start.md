> [!NOTE] The scaffold is on npm
> `@eve-cyno/create-plugin` is published. Step 1 runs it with `npm create @eve-cyno/plugin@latest my-plugin`. To run the scaffold from a clone of the plugin repository instead, use this from the root of the clone:
>
> `node sdk/create-plugin/bin/create-plugin.mjs my-plugin`
>
> It asks for an id, a name, an author and a one-line description (add `--yes --id <id> --author <author>` to skip the questions). Everything below is the same either way.

After step 1, run `npm install` once inside the new folder. It installs TypeScript, the only dev dependency, and `npm run build` needs it.

The id must be three or more lower-case dotted words, such as `com.example.my-plugin`. The scaffold refuses an id that starts with `eve-cyno.host.` or contains `eve-cyno`, and a name or author that reads as the app (`EVE-Cyno`, `Settings`, `Characters`, `Marketplace`, `Home`). It writes nothing when it refuses.
