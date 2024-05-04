import { libWrapper } from "pf2e-api";
import { createTool } from "../tool";

const { config, settings, wrappers } = createTool({
    name: "noBulk",
    settings: [
        {
            key: "dropped",
            type: Boolean,
            default: false,
            requiresReload: true,
        },
        {
            key: "coins",
            type: Boolean,
            default: false,
            requiresReload: true,
        },
    ],
    wrappers: [
        {
            key: "dropped",
            path: "CONFIG.Actor.documentClass.prototype.prepareEmbeddedDocuments",
            callback: actorPrepareEmbeddedDocuments,
        },
        {
            key: "coins",
            path: "CONFIG.PF2E.Item.documentClasses.treasure.prototype.prepareBaseData",
            callback: treasurePreparedBaseData,
        },
    ],
    init: () => {
        wrappers.dropped.toggle(settings.dropped);
        wrappers.coins.toggle(settings.coins);
    },
} as const);

function actorPrepareEmbeddedDocuments(this: ActorPF2e, wrapped: libWrapper.RegisterCallback) {
    wrapped();

    const InventoryBulkClass = this.inventory.bulk.constructor as typeof InventoryBulk;

    let _value: Bulk | null = null;

    Object.defineProperty(this.inventory.bulk, "value", {
        get(this: InventoryBulk): Bulk {
            if (_value) return _value;

            _value = InventoryBulkClass.computeTotalBulk(
                this.actor.inventory.filter(
                    (item) => !item.isInContainer && item.system.equipped.carryType !== "dropped"
                ),
                this.actor.size
            );

            return _value;
        },
    });
}

function treasurePreparedBaseData(this: TreasurePF2e, wrapped: libWrapper.RegisterCallback) {
    wrapped();

    if (this.isCoinage) {
        this.system.bulk.value = 0;
    }
}

export { config as noBulkTool };