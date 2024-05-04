import { libWrapper } from "pf2e-api";
import { createSharedWrapper } from "./sharedWrapper";

const WEAPON_PREPARE_BASE_DATA =
    "CONFIG.PF2E.Item.documentClasses.weapon.prototype.prepareBaseData";
const WEAPON_PREPARE_DERIVED_DATA =
    "CONFIG.PF2E.Item.documentClasses.weapon.prototype.prepareDerivedData";
const ARMOR_PREPARE_BASE_DATA = "CONFIG.PF2E.Item.documentClasses.armor.prototype.prepareBaseData";
const ARMOR_PREPARE_DERIVED_DATA =
    "CONFIG.PF2E.Item.documentClasses.armor.prototype.prepareDerivedData";

const prepareDocumentWrappers = {
    [WEAPON_PREPARE_BASE_DATA]: createSharedWrapper(
        WEAPON_PREPARE_BASE_DATA,
        prepareBaseData<WeaponPF2e>
    ),
    [ARMOR_PREPARE_BASE_DATA]: createSharedWrapper(
        ARMOR_PREPARE_BASE_DATA,
        prepareBaseData<ArmorPF2e>
    ),
};

function prepareBaseData<T extends FoundryDocument>(
    this: T,
    listeners: (() => void)[],
    wrapped: libWrapper.RegisterCallback
) {
    for (const listener of listeners) {
        listener.call(this);
    }

    wrapped();
}

export {
    ARMOR_PREPARE_BASE_DATA,
    ARMOR_PREPARE_DERIVED_DATA,
    WEAPON_PREPARE_BASE_DATA,
    WEAPON_PREPARE_DERIVED_DATA,
    prepareDocumentWrappers,
};
