## Licences

| Piece | Licence |
|---|---|
| The scaffold package `@eve-cyno/create-plugin` (`sdk/create-plugin/` in the plugin repository) | MIT |
| The files the scaffold writes into your project | MIT-0: you owe no notice, and you pick any licence for your plugin |
| The plugin API types, bundled in every generated project and vendored in the plugin repository | MIT |
| This documentation site: its code and its text | MIT |

The plugin repository is MIT as a whole, except the files under `vendor/eve-cyno-host/`, which are copies of modules of the desktop app under PolyForm Strict 1.0.0. They are used by the repository's own tests and checks and are never part of the scaffold or of a generated project.

## Your plugin

The scaffold writes a `LICENSE` file with the MIT-0 text ("MIT No Attribution") into your project and no `license` field in `package.json`. The README it writes asks you to replace that file with the licence you pick before you publish. Your plugin may use any licence. The one folder with a licence of its own is `types/eve-cyno-plugin-api/`, the API's declarations: it carries its MIT `LICENSE`, which you keep when you ship it.

Text on the API pages is taken from the plugin API README, which is under the same MIT licence.

## EVE Online and Fenris Creations

EVE Online and all related materials are the property of Fenris Creations. EVE-Cyno is not affiliated with Fenris Creations. The full notice is in the footer of every page of this site.

The review policy lists what the index does not list: anything against Fenris Creations' terms, such as client modification, botting or real-money trading. See [Review policy](@@policy).
