> [!NOTE] The scaffold is not on npm yet
> `@eve-cyno/create-plugin` is not published, so `npm create @eve-cyno/plugin` does not work today. Run the scaffold from the root of a clone of the plugin repository instead:
>
> `node sdk/create-plugin/bin/create-plugin.mjs my-plugin`
>
> It asks for an id, a name, an author and a one-line description (add `--yes --id <id> --author <author>` to skip the questions). Everything below is the same either way: the command in step 1 is the one to use once the package is published.

After step 1, run `npm install` once inside the new folder. It installs TypeScript, the only dev dependency, and `npm run build` needs it.

The id must be three or more lower-case dotted words, such as `com.example.my-plugin`. The scaffold refuses an id that starts with `eve-cyno.host.` or contains `eve-cyno`, and a name or author that reads as the app (`EVE-Cyno`, `Settings`, `Characters`, `Marketplace`, `Home`). It writes nothing when it refuses.
