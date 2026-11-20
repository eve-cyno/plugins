## What a plugin is

An EVE-Cyno plugin is a folder with a manifest, `plugin.json`, and one HTML page, named by the manifest's `main`, with the scripts and styles it loads. The desktop app opens that page inside the app. The plugin adds a tile, commands and its own screens to the app, and it can use the app's data and tools through the plugin API.

The manifest names the plugin, says which plugin API it needs (`engines.eve-cyno-api`) and lists every permission it asks for. Read [plugin.json](@@manifest) for every property.

## The sandbox

A plugin does not run inside the app's own page. Each plugin page gets its own browser view with these settings, set in the app and not by the plugin:

- the renderer is sandboxed, with context isolation on and Node.js integration off, so the page cannot read files or start programs by itself;
- the plugin has its own storage area, separate from every other plugin;
- the page reaches the app only through the plugin API, which the app injects into the page as the `eveCyno` global. A plugin that does not ask for a permission in `plugin.json` does not get the part of the API that needs it.

The API also limits how often a plugin may call it: all pages of one plugin share a budget of 100 calls, refilled at 100 a second. A call past the budget is refused with `rate_limited` before it runs. See [the API overview](@@api) for the rest.

## What you can build

The API is a set of namespaces, for example `theme`, `commands` and `tile` (always present) and optional ones such as `files`, `esi`, `fit` or `overlays`, which a plugin gets only when its manifest asks for the permission and the user allows it. The [API overview](@@api) lists them all with what each one is for; each has a page with its declarations.

## Where to start

1. [Getting started](@@start): make a plugin from the template, build it and load it in the app. About five minutes.
2. [Tutorial](@@tutorial): read the generated plugin file by file.
3. [Local testing](@@local-testing): the developer folder and how a plugin loads from it.
4. [plugin.json](@@manifest) and [Permissions and grants](@@permissions): what the manifest may say and what each permission unlocks.

## The Marketplace

<!-- not-live -->
**The plugin Marketplace is not open yet.** The public plugin index is not published: no plugin is listed, and nobody can install a plugin from it. Until it opens, a plugin runs from a folder you load yourself on your own machine, and nobody else can find it.

The pages under Publish describe the process for the day it opens: how a plugin is packaged ([Archive rules](@@packaging)), how it is submitted ([Submitting a plugin](@@submitting)), what the checks do ([Checks](@@checks)) and what gets a plugin refused ([Review policy](@@policy)). They are accurate for the repository that will hold the index; they are not a promise of a date.
<!-- /not-live -->
<!-- live -->
The plugin Marketplace is open. A plugin that passes the checks and review is listed there and the app installs it after the user allows the permissions it asks for.

The pages under Publish describe the process: how a plugin is packaged ([Archive rules](@@packaging)), how it is submitted ([Submitting a plugin](@@submitting)), what the checks do ([Checks](@@checks)) and what gets a plugin refused ([Review policy](@@policy)).
<!-- /live -->

## Licences

The plugin API types, the scaffold and these docs are MIT. See [Licences](@@licence).
