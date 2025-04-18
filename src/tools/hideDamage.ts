import { ChatMessagePF2e, htmlQuery, refreshLatestMessages } from "module-helpers";
import { createTool } from "../tool";
import { CHATMESSAGE_GET_HTML } from "./shared/chatMessage";

const { config, settings, wrapper, localize, getFlag, setFlag } = createTool({
    name: "hideDamage",
    settings: [
        {
            key: "enabled",
            type: Boolean,
            default: false,
            onChange: (enabled) => {
                wrapper.toggle(enabled);
                refreshLatestMessages(20);
            },
        },
    ],
    wrappers: [
        {
            key: "messageGetHTML",
            path: CHATMESSAGE_GET_HTML,
            callback: chatMessageGetHTML,
        },
    ],
    init: () => {
        wrapper.toggle(settings.enabled);
    },
} as const);

async function chatMessageGetHTML(this: ChatMessagePF2e, html: HTMLElement) {
    if (!this.isContentVisible || !this.isDamageRoll) return;

    const actor = this.actor;
    const author = this.author;
    if (actor?.hasPlayerOwner || (!actor && author && !author.isGM)) return;

    const revealed = getFlag<boolean>(this, "revealed");
    if (revealed) return;

    const isGM = game.user.isGM;
    const diceResult = htmlQuery(html, ".dice-result");
    const diceTotalElement = htmlQuery(diceResult, ".dice-total");
    const totalElement = htmlQuery(diceTotalElement, ":scope > .total");
    const instancesElement = htmlQuery(diceTotalElement, ":scope > .instances");

    if (totalElement) {
        if (isGM) {
            totalElement.dataset.visibility = "gm";
            totalElement.dataset.tooltip = localize("reveal");
            totalElement.classList.add("clickable");

            totalElement.addEventListener("click", (event) => {
                event.preventDefault();
                setFlag(this, "revealed", true);
            });
        } else {
            totalElement.dataset.tooltip = "";
            totalElement.innerText = "???";
            htmlQuery(diceResult, ".dice-tooltip")?.remove();
        }
    }

    if (instancesElement) {
        if (isGM) {
            instancesElement.dataset.visibility = "gm";
        } else {
            instancesElement.remove();
        }
    }
}

export { config as hideDamageTool };
