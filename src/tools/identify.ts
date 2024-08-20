import {
    addListenerAll,
    confirmDialog,
    createHTMLElement,
    DateTime,
    elementDataset,
    htmlClosest,
    htmlQuery,
    htmlQueryAll,
    IdentifyItemPopup,
    promptDialog,
    R,
} from "foundry-pf2e";
import { createTool } from "../tool";

const PARTIAL_SLUGH_REGEX = / ?\(.+\) ?/g;

const { config, settings, localize, hook, socket, render, getFlag, flagPath } = createTool({
    name: "identify",
    settings: [
        {
            key: "enabled",
            type: Boolean,
            default: false,
            scope: "world",
            onChange: (enabled: boolean) => {
                const isGM = game.user.isGM;
                const playerRequest = settings.playerRequest;

                hook.toggle(enabled && (isGM || playerRequest));
                socket.toggle(enabled && isGM && playerRequest);

                if (enabled) refreshTracker();
                else closeTracker();
            },
        },
        {
            key: "stash",
            type: Boolean,
            default: true,
            scope: "world",
            onChange: (value: boolean) => {
                refreshTracker(!value);
            },
        },
        {
            key: "delay",
            type: Boolean,
            default: false,
            scope: "world",
            onChange: () => {
                refreshTracker();
            },
        },
        {
            key: "playerRequest",
            type: Boolean,
            default: true,
            scope: "world",
            onChange: (value: boolean) => {
                const isGM = game.user.isGM;
                const enabled = settings.enabled;

                hook.toggle(enabled && (isGM || value));
                socket.toggle(enabled && isGM && value);
            },
        },
    ],
    hooks: [
        {
            event: "renderCharacterSheetPF2e",
            listener: onRenderCharacterSheetPF2e,
        },
    ],
    api: {
        openTracker,
    },
    onSocket: async (packet: SocketPacket, userId: string) => {
        if (game.user === game.users.activeGM) {
            onRequestReceived(packet.itemUUID, userId);
        }
    },
    init: (isGM) => {
        if (!settings.enabled) return;

        const playerRequest = settings.playerRequest;

        if (isGM || playerRequest) hook.activate();
        if (isGM && playerRequest) socket.activate();
    },
} as const);

async function onRequestReceived(itemUUID: string, userId: string) {
    const user = game.users.get(userId);
    const item = await fromUuid<ItemPF2e>(itemUUID);
    if (!user || !item?.isOfType("physical")) return;

    const confirm = await confirmDialog({
        title: user.name,
        content: await render("request", { item: item.system.identification.identified }),
    });

    if (confirm) {
        openTracker(item);
    }
}

function onRenderCharacterSheetPF2e(sheet: CharacterSheetPF2e) {
    const isGM = game.user.isGM;
    const actor = sheet.actor;
    if (!isGM && !actor.isOwner) return;

    const tab = htmlQuery(sheet.element[0], ".tab.inventory");
    if (!tab) return;

    const itemsElements = tab.querySelectorAll<HTMLLIElement>(
        "li[data-item-id],li[data-subitem-id]"
    );

    for (const itemElement of itemsElements) {
        const { itemId, subitemId } = itemElement.dataset;
        const realItemId = subitemId
            ? htmlClosest(itemElement, "[data-item-id]")?.dataset.itemId
            : itemId;
        const realItem = actor.inventory.get(realItemId, { strict: true });
        const item = subitemId ? realItem.subitems.get(subitemId, { strict: true }) : realItem;

        if (item.isIdentified) continue;

        if (isGM) {
            const systemToggle = htmlQuery(itemElement, "[data-action='toggle-identified']");
            systemToggle?.remove();
        }

        const siblingElement = htmlQuery(
            itemElement,
            `[data-action="${isGM ? "edit-item" : "delete-item"}"]`
        );
        if (!siblingElement) continue;

        const toggleElement = createHTMLElement("a", {
            dataset: {
                action: "pf2e-toobelt-identify",
                tooltip: "PF2E.identification.Identify",
            },
            innerHTML: "<i class='fa-solid fa-question-circle fa-fw'></i>",
        });

        siblingElement.before(toggleElement);

        toggleElement.addEventListener("click", () => {
            if (game.user.isGM) {
                openTracker(item);
            } else {
                localize.info("request.sent");
                socket.emit({ itemUUID: item.uuid });
            }
        });
    }
}

class PF2eToolbeltIdentify extends foundry.applications.api.ApplicationV2 {
    static instance: PF2eToolbeltIdentify | null = null;

    #HOOKS: [string, HookCallback][] = [
        ["updateWorldTime", () => this.render()],
        ["updateActor", this.#onActorUpdate.bind(this)],
        ["updateItem", this.#onItemUpdate.bind(this)],
        // TODO add delete/create variants
    ];

    #unlockedUUIDs: ItemUUID[] = [];
    #loading = false;
    #knownUUIDs: ItemUUID[] = [];
    #itemsUUIDs: ItemUUID[] = [];
    #removedFaillures: Record<string, Set<string>> = {};
    #updates: Record<string, Record<string, "success" | "fail">> = {};

    constructor(item?: ItemPF2e, options: PartialApplicationConfiguration = {}) {
        options.id = localize("tracker");
        options.window ??= {};
        options.window.title = localize("tracker.title");

        super(options);

        if (this.isValidItem(item)) {
            this.#unlockedUUIDs.push(item.uuid);
        }
    }

    async _prepareContext(options: TrackerRenderOptions): Promise<TrackerContext> {
        const party = game.actors.party;
        const members = party?.members ?? [];
        const actors = members.filter((actor) => actor.isOfType("character"));
        const identifications: Record<string, IdenfifiedFlag> = {};
        const spellLists: Record<string, SpellList> = {};
        const itemGroups: Partial<Record<PhysicalItemType, GroupItem[]>> = {};
        const items: PhysicalItemPF2e<ActorPF2e>[] = R.pipe(
            members,
            R.flatMap((actor) => actor.inventory.contents),
            R.filter((item) => !item.isIdentified)
        );
        const useDelay = settings.delay;
        const worldClock = game.pf2e.worldClock;
        const worldTime = worldClock.worldTime;
        const DateTimeCls = worldTime.constructor as typeof DateTime;

        for (const actor of actors) {
            identifications[actor.id] = getFlag<IdenfifiedFlag>(actor, "identified") ?? {};
        }

        if (party && settings.stash) {
            items.push(...party.inventory.contents.filter((item) => !item.isIdentified));
        }

        const ghostItems = R.pipe(
            await Promise.all(
                R.pipe(
                    this.#itemsUUIDs,
                    R.difference(items.map((item) => item.uuid)),
                    R.map((uuid) => fromUuid<PhysicalItemPF2e>(uuid))
                )
            ),
            R.filter(R.isTruthy),
            R.filter((item): item is PhysicalItemPF2e<ActorPF2e> => {
                const actor = item.actor;
                return actor === party || (!!actor && actors.includes(actor as CharacterPF2e));
            })
        );

        const hasLockedItems =
            this.#unlockedUUIDs.length > 0 && this.#unlockedUUIDs.length < items.length;
        const allItems = [...items, ...ghostItems];

        this.#knownUUIDs = [];
        this.#removedFaillures = {};
        this.#itemsUUIDs = allItems.map((item) => item.uuid);

        for (const item of allItems) {
            const itemUuid = item.uuid;
            const itemIdentified = item.isIdentified;
            const data = item.system.identification.identified;
            const isConsumable = item.isOfType("consumable");
            const scrollWandSpell =
                isConsumable && ["wand", "scroll"].includes(item.category) && item.embeddedSpell;
            const itemTraditions =
                scrollWandSpell && scrollWandSpell.rarity === "common"
                    ? scrollWandSpell.traditions
                    : undefined;
            const itemSlug = scrollWandSpell
                ? scrollWandSpell.slug ?? game.pf2e.system.sluggify(scrollWandSpell.name)
                : item.slug ?? game.pf2e.system.sluggify(data.name);
            const partialSlug =
                isConsumable && !scrollWandSpell
                    ? game.pf2e.system.sluggify(data.name.replaceAll(PARTIAL_SLUGH_REGEX, ""))
                    : undefined;
            const fails = getFlag<FailedFlag>(item, "failed") ?? {};
            const isLocked =
                !itemIdentified && hasLockedItems && !this.#unlockedUUIDs.includes(itemUuid);

            const itemClasses: (string | boolean)[] = [
                itemIdentified && "identified",
                isLocked && "locked",
            ];

            (itemGroups[item.type] ??= []).push({
                itemSlug,
                isLocked,
                partialSlug,
                img: data.img,
                uuid: itemUuid,
                name: data.name,
                owner: item.actor,
                css: itemClasses.join(" "),
                isIdentified: itemIdentified,
                actors: actors.map((actor): ItemActor | { id: string } => {
                    const actorId = actor.id;

                    if (itemIdentified) return { id: actorId };

                    const failed = (() => {
                        const fail = fails[actorId];
                        if (!fail) return 0;

                        const failTime = DateTimeCls.fromISO(fail);
                        const diffTime = worldTime.diff(failTime, useDelay ? "hours" : "days");
                        const removeFail = useDelay ? diffTime.hours >= 24 : diffTime.days >= 1;

                        if (removeFail) {
                            const toRemove = (this.#removedFaillures[itemUuid] ??= new Set());
                            toRemove.add(actorId);
                        }

                        return removeFail ? 0 : useDelay ? 24 - diffTime.hours : 1;
                    })();

                    const known = (() => {
                        if (failed) return false;

                        const identification = identifications[actorId]?.[item.type] ?? [];
                        const full = identification.find((x) => x.itemSlug === itemSlug);

                        if (full) return true;

                        if (partialSlug) {
                            const partial = identification.find(
                                (x) => x.partialSlug === partialSlug
                            );
                            if (partial?.itemName) {
                                return partial.itemName;
                            }
                        }

                        return false;
                    })();

                    if (known !== false) {
                        this.#knownUUIDs.push(itemUuid);
                    }

                    const canRecallKnowledge = (() => {
                        if (failed || known !== false || !scrollWandSpell) return false;

                        const list = (spellLists[actorId] ??= getSpellList(actor));
                        const isTradition =
                            !!itemTraditions &&
                            list.traditions.some((tradition) => itemTraditions.has(tradition));

                        return isTradition || list.known.includes(itemSlug);
                    })();

                    const tooltip = failed
                        ? useDelay
                            ? localize("tracker.failed.delay", { hours: failed })
                            : localize("tracker.failed.daily")
                        : typeof known === "string"
                        ? localize("tracker.known.partial", { item: known })
                        : known === true
                        ? localize("tracker.known.full")
                        : canRecallKnowledge
                        ? localize("tracker.known.recall")
                        : "";

                    const update =
                        !failed && known !== true ? this.#updates[itemUuid]?.[actorId] : undefined;

                    const canToggle = !itemIdentified && !failed && known !== true;

                    const actorClasses: (string | false)[] = [
                        failed !== 0 && "failed",
                        canToggle && "toggleable",
                    ];

                    return {
                        id: actorId,
                        known,
                        update,
                        tooltip,
                        canToggle,
                        canRecallKnowledge,
                        failed: failed !== 0,
                        css: actorClasses.join(" "),
                    };
                }),
            });
        }

        const time =
            worldClock.timeConvention === 24
                ? worldTime.toFormat("HH:mm")
                : worldTime.toLocaleString(DateTimeCls.TIME_SIMPLE);

        const date = worldTime.toLocaleString(DateTimeCls.DATE_SHORT);

        return {
            time,
            date,
            actors,
            itemGroups: R.pipe(
                R.entries(itemGroups),
                R.map(([type, items]) => ({
                    type,
                    label: game.i18n.localize(`TYPES.Item.${type}`),
                    items: R.sortBy(items, R.prop("name")),
                })),
                R.sortBy(R.prop("label"))
            ),
        };
    }

    protected _onFirstRender(context: ApplicationRenderContext, options: TrackerRenderOptions) {
        for (const [event, callback] of this.#HOOKS) {
            Hooks.on(event, callback);
        }
    }

    async _renderHTML(context: TrackerContext, options: TrackerRenderOptions) {
        return render("tracker", context);
    }

    _replaceHTML(result: string, content: HTMLElement, options: TrackerRenderOptions) {
        const prevChild = content.firstElementChild;
        const scrollEl = htmlQuery(prevChild, ".items");
        const scrollPos = scrollEl ? { left: scrollEl.scrollLeft, top: scrollEl.scrollTop } : null;

        const newChildren = createHTMLElement("div", { innerHTML: result }).children;

        if (prevChild) content.replaceChildren(...newChildren);
        else content.append(...newChildren);

        if (scrollPos) {
            const scrollEl = htmlQuery(content, ".items")!;
            scrollEl.scrollLeft = scrollPos.left;
            scrollEl.scrollTop = scrollPos.top;
        }

        this.#activateListeners(content);
    }

    _onClose(options: ApplicationClosingOptions): void {
        PF2eToolbeltIdentify.instance = null;
        for (const [event, callback] of this.#HOOKS) {
            Hooks.off(event, callback);
        }
    }

    async render(options?: boolean | TrackerRenderOptions, _options?: ApplicationRenderOptions) {
        if (this.#loading) return this;

        if (typeof options === "object" && options.fullReset) {
            this.#itemsUUIDs = [];
            this.#reset();
        }

        return super.render(options, _options);
    }

    isValidItem(item?: ItemPF2e): item is PhysicalItemPF2e<CharacterPF2e> {
        return item instanceof Item && item.isOfType("physical") && this.isValidActor(item.actor);
    }

    isValidActor(actor?: ActorPF2e | null): actor is CharacterPF2e {
        if (!(actor instanceof Actor)) return false;

        const party = game.actors.party;
        const members = party?.members ?? [];

        return actor === party || (actor.isOfType("character") && members.includes(actor));
    }

    unlockItem(itemOrUUID: ItemPF2e | ItemUUID) {
        const itemUUID =
            typeof itemOrUUID === "string"
                ? itemOrUUID
                : this.isValidItem(itemOrUUID)
                ? itemOrUUID.uuid
                : undefined;

        if (
            !itemUUID ||
            this.#unlockedUUIDs.includes(itemUUID) ||
            !this.#itemsUUIDs.includes(itemUUID)
        )
            return;

        const hadLockedItems = this.#unlockedUUIDs.length > 0;

        this.#unlockedUUIDs.push(itemUUID);

        if (!hadLockedItems) {
            return this.render();
        }

        const elements = this.element.querySelectorAll(`[data-item-uuid="${itemUUID}"]`);

        for (const element of elements) {
            element.classList.remove("locked");
        }
    }

    #reset() {
        this.#updates = {};
        this.render();
    }

    #setLoading(enabled: boolean) {
        this.#loading = enabled;
        this.element.classList.toggle("loading", enabled);
    }

    #onActorUpdate(actor: ActorPF2e) {
        if (actor === game.actors.party) {
            this.render();
        }
    }

    #onItemUpdate(item: ItemPF2e) {
        if (this.isValidItem(item)) {
            this.render();
        }
    }

    #activateListeners(html: HTMLElement) {
        addListenerAll(html, ".highlight", "mouseenter", (event, el) => {
            if (el.classList.contains("locked")) return;

            const { itemUuid, actorId } = el.dataset;

            const cells: Element[] = [];

            if (actorId) {
                const actorCells = html.querySelectorAll(`.highlight[data-actor-id="${actorId}"]`);
                cells.push(...actorCells);
            }

            if (itemUuid) {
                const itemCells = html.querySelectorAll(`.highlight[data-item-uuid="${itemUuid}"]`);
                cells.push(...itemCells);
            }

            for (const cell of cells) {
                cell.classList.add("highlighted");
            }
        });

        addListenerAll(html, ".highlight", "mouseleave", (event, el) => {
            const cells = html.querySelectorAll(".highlighted");

            for (const cell of cells) {
                cell.classList.remove("highlighted");
            }
        });

        addListenerAll(html, ".item-actor.toggleable", "mousedown", (event, el) => {
            if (![0, 2].includes(event.button)) return;

            const { itemUuid, actorId } = elementDataset<CellData>(el);

            if (el.classList.contains("locked")) {
                this.unlockItem(itemUuid);
                return;
            }

            const direction = event.button === 0 ? +1 : -1;
            const itemUpdate = (this.#updates[itemUuid] ??= {});
            const currentUpdate = itemUpdate[actorId];
            const currentValue = currentUpdate === "success" ? 2 : currentUpdate === "fail" ? 0 : 1;
            const newValue = Math.clamp(currentValue + direction, 0, 2);
            const newUpdate = newValue === 0 ? "fail" : newValue === 2 ? "success" : undefined;

            if (newUpdate) {
                el.dataset.update = newUpdate;
                itemUpdate[actorId] = newUpdate;
            } else {
                delete el.dataset.update;
                delete this.#updates[itemUuid]?.[actorId];
            }
        });

        addListenerAll(html, "[data-action]", async (event, el) => {
            const action = el.dataset.action as TrackerEventAction;

            const getItem = async () => {
                const itemUuid = htmlClosest(el, "[data-item-uuid]")?.dataset.itemUuid;
                return itemUuid ? await fromUuid<PhysicalItemPF2e<CreaturePF2e>>(itemUuid) : null;
            };

            switch (action) {
                case "auto": {
                    this.#identifyAll();
                    break;
                }

                case "reset": {
                    this.#reset();
                    break;
                }

                case "save": {
                    this.#saveChanges();
                    break;
                }

                case "open-clock": {
                    game.pf2e.worldClock.render(true);
                    break;
                }

                case "change-time": {
                    const direction = el.dataset.direction as "+" | "-";
                    const WorldClockCls = game.pf2e.worldClock.constructor as typeof WorldClock;
                    const worldTime = game.pf2e.worldClock.worldTime;
                    const increment = WorldClockCls.calculateIncrement(worldTime, "600", direction);
                    if (increment !== 0) game.time.advance(increment);
                    break;
                }

                case "open-item-sheet": {
                    const item = await getItem();
                    item?.sheet.render(true);
                    break;
                }

                case "open-actor-sheet": {
                    const item = await getItem();
                    item?.actor.sheet.render(true, { tab: "inventory" });
                    break;
                }

                case "identify-item": {
                    const item = await getItem();
                    item?.setIdentificationStatus("identified");
                    break;
                }

                case "mystify-item": {
                    const item = await getItem();
                    item?.setIdentificationStatus("unidentified");
                    break;
                }

                case "misidentify-item": {
                    break;
                }

                case "send-to-chat": {
                    const item = await getItem();
                    item?.toMessage();
                    break;
                }

                case "post-skill-checks": {
                    const item = await getItem();
                    if (!item) return;

                    const app = new IdentifyItemPopup(item);
                    app.requestChecks();

                    break;
                }
            }
        });
    }

    async #identifyAll() {
        const selectedList =
            this.#unlockedUUIDs.length > 0
                ? R.intersection(this.#knownUUIDs, this.#unlockedUUIDs)
                : this.#knownUUIDs;

        const items = R.pipe(
            await Promise.all(
                selectedList.map((itemUuid) => fromUuid<PhysicalItemPF2e<CreaturePF2e>>(itemUuid))
            ),
            R.filter((item): item is PhysicalItemPF2e<CreaturePF2e> => !!item && !item.isIdentified)
        );

        if (!items.length) {
            promptDialog({
                title: localize("tracker.auto.title"),
                content: localize("tracker.auto.none"),
            });
            return;
        }

        const confirm = await confirmDialog({
            title: localize("tracker.auto.title"),
            content: localize("tracker.auto.content", {
                items: createDialogItemList(items),
            }),
        });

        if (!confirm) return;

        this.#setLoading(true);

        await this.#identifyList(items);

        this.#setLoading(false);
        this.render();
    }

    async #identifyList(items: PhysicalItemPF2e<CreaturePF2e>[]) {
        const actorsUpdates: Record<
            string,
            { actor: CreaturePF2e; items: PhysicalItemPF2e<CreaturePF2e>[] }
        > = {};

        for (const item of items) {
            const actorUpdates = (actorsUpdates[item.actor.id] ??= {
                actor: item.actor,
                items: [],
            });
            actorUpdates.items.push(item);
        }

        return Promise.all(
            Object.values(actorsUpdates).map(({ actor, items }) => {
                const updates = items.map((item) => ({
                    _id: item.id,
                    [flagPath("-=failed")]: true,
                    ["system.identification.status"]: "identified",
                    ["system.identification.unidentified"]: item.getMystifiedData("unidentified"),
                }));
                return actor.updateEmbeddedDocuments("Item", updates);
            })
        );
    }

    async #saveChanges() {
        const actors: Record<string, ActorPF2e | undefined> = {};
        const items: Record<string, PhysicalItemPF2e<CreaturePF2e> | null> = {};
        const toIdentify: PhysicalItemPF2e<CreaturePF2e>[] = [];
        const identifyUpdates: Record<string, IdenfifiedFlag> = {};
        const failUpdates: Record<string, Record<string, FailedFlag>> = {};
        const updateElements = htmlQueryAll(this.element, "[data-update]");
        const worldTime = game.pf2e.worldClock.worldTime.toString();

        const getActor = (actorId: string) => {
            return (actors[actorId] ??= game.actors.get(actorId));
        };

        const getItem = async (itemUuid: string) => {
            return (items[itemUuid] ??= await fromUuid(itemUuid));
        };

        const addFailedUpdate = (
            item: PhysicalItemPF2e<CreaturePF2e>,
            actorId: string,
            remove: boolean
        ) => {
            const actorUpdates = (failUpdates[item.actor.id] ??= {});
            const itemUpdates = (actorUpdates[item.id] ??= {});
            itemUpdates[remove ? `-=${actorId}` : actorId] = worldTime;
        };

        await Promise.all(
            updateElements.map(async (updateElement) => {
                const { actorId, itemUuid, update, type, itemSlug, itemName, partialSlug } =
                    elementDataset<CellData>(updateElement);

                const item = await getItem(itemUuid);
                const actor = getActor(actorId);
                if (!actor || !item) return;

                this.#removedFaillures[itemUuid]?.delete(actorId);

                if (update === "success") {
                    const updates = (identifyUpdates[actorId] ??= foundry.utils.deepClone(
                        getFlag<IdenfifiedFlag>(actor, "identified") ?? {}
                    ));

                    if (!item.isIdentified) {
                        toIdentify.push(item);
                    }

                    (updates[type] ??= []).push({
                        itemSlug,
                        itemName,
                        partialSlug,
                    });
                } else {
                    addFailedUpdate(item, actorId, false);
                }
            })
        );

        if (toIdentify.length) {
            const confirm = await confirmDialog({
                title: localize("tracker.save.title"),
                content: localize("tracker.save.content", {
                    items: createDialogItemList(toIdentify),
                }),
            });
            if (!confirm) return;
        }

        this.#setLoading(true);

        if (!R.isEmpty(identifyUpdates)) {
            const updates = R.pipe(
                R.entries(identifyUpdates),
                R.map(([actorId, update]) => {
                    return {
                        _id: actorId,
                        [flagPath("identified")]: update,
                    };
                })
            );

            await Actor.updateDocuments(updates);
        }

        for (const [itemUuid, actors] of Object.entries(this.#removedFaillures)) {
            const item = await getItem(itemUuid);
            if (!item) continue;

            for (const actorId of actors) {
                addFailedUpdate(item, actorId, true);
            }
        }

        await Promise.all(
            Object.entries(failUpdates).map(([actorId, actorUpdates]) => {
                const actor = getActor(actorId);
                if (!actor) return;

                const updates: EmbeddedDocumentUpdateData[] = [];

                for (const [itemId, failUpdate] of R.entries(actorUpdates)) {
                    const update: EmbeddedDocumentUpdateData = {
                        _id: itemId,
                    };

                    const toId = toIdentify.findSplice(
                        (item) => item.actor === actor && item.id === itemId
                    );

                    if (toId) {
                        update[flagPath("-=failed")] = true;
                        update["system.identification.status"] = "identified";
                        update["system.identification.unidentified"] =
                            toId.getMystifiedData("unidentified");
                    } else {
                        update[flagPath("failed")] = failUpdate;
                    }

                    updates.push(update);
                }

                return actor.updateEmbeddedDocuments("Item", updates);
            })
        );

        if (toIdentify.length) {
            await this.#identifyList(toIdentify);
        }

        this.#setLoading(false);
        this.#reset();
    }
}

function createDialogItemList(items: PhysicalItemPF2e[]) {
    return R.pipe(
        items,
        R.sortBy((item) => item.system.identification.identified.name),
        R.map((item) => `<li>${item.system.identification.identified.name}</li>`),
        R.join("")
    );
}

function refreshTracker(fullReset?: boolean) {
    PF2eToolbeltIdentify.instance?.render({ fullReset });
}

function closeTracker() {
    PF2eToolbeltIdentify.instance?.close();
}

function openTracker(item?: ItemPF2e) {
    if (!game.user.isGM) return;

    if (PF2eToolbeltIdentify.instance) {
        PF2eToolbeltIdentify.instance.bringToFront();
        if (item) PF2eToolbeltIdentify.instance.unlockItem(item);
    } else {
        PF2eToolbeltIdentify.instance = new PF2eToolbeltIdentify(item);
        PF2eToolbeltIdentify.instance.render(true);
    }

    return PF2eToolbeltIdentify.instance;
}

function getSpellList(actor: CharacterPF2e): SpellList {
    const traditions: Set<MagicTradition> = new Set();
    const known: Set<string> = new Set();

    for (const entry of actor.spellcasting.regular) {
        const tradition = entry.tradition;

        if (tradition) {
            traditions.add(tradition);
        }

        for (const spell of entry.spells ?? []) {
            if (spell.rarity !== "common" || !tradition) {
                known.add(spell.slug ?? game.pf2e.system.sluggify(spell.name));
            }
        }
    }

    return {
        traditions: [...traditions],
        known: [...known],
    };
}

type TrackerEventAction =
    | "auto"
    | "save"
    | "reset"
    | "open-clock"
    | "change-time"
    | "open-actor-sheet"
    | "open-item-sheet"
    | "mystify-item"
    | "identify-item"
    | "send-to-chat"
    | "post-skill-checks"
    | "misidentify-item";

type SocketPacket = {
    itemUUID: ItemUUID;
};

type TrackerRenderOptions = ApplicationRenderOptions & {
    fullReset?: boolean;
};

type CellData = {
    update: "fail" | "success";
    actorId: string;
    itemUuid: ItemUUID;
    type: PhysicalItemType;
    itemSlug: string;
    itemName?: string;
    partialSlug?: string;
};

type SpellList = {
    traditions: MagicTradition[];
    known: string[];
};

type FailedFlag = Record<string, string>;

type IdenfifiedFlag = Partial<
    Record<
        PhysicalItemType,
        {
            itemSlug: string;
            itemName?: string;
            partialSlug?: string;
        }[]
    >
>;

type ItemActor = {
    id: string;
    css: string;
    failed: boolean;
    tooltip: string;
    canToggle: boolean;
    canRecallKnowledge: boolean;
    known: boolean | string;
    update: "success" | "fail" | undefined;
};

type GroupItem = {
    img: string;
    css: string;
    uuid: string;
    name: string;
    itemSlug: string;
    isLocked: boolean;
    actors: (ItemActor | { id: string })[];
    isIdentified: boolean;
    partialSlug: string | undefined;
    owner: { name: string; id: string };
};

type TrackerContext = {
    time: string;
    date: string;
    actors: CharacterPF2e[];
    itemGroups: {
        type: PhysicalItemType;
        label: string;
        items: GroupItem[];
    }[];
};

export { config as identifyTool };