import { createBot } from 'mineflayer'
import { createFastWindowClicker } from './fastWindowClick'
import { addLoggerToClientWriteFunction, initLogger, log, printMcChatToConsole } from './logger'
import { clickWindow, isCoflChatMessage, sleep } from './utils'
import { onWebsocketCreateAuction } from './sellHandler'
import { tradePerson } from './tradeHandler'
import { swapProfile } from './swapProfileHandler'
import { flipHandler } from './flipHandler'
import { claimSoldItem, registerIngameMessageHandler } from './ingameMessageHandler'
import { MyBot, TextMessageData } from '../types/autobuy'
import { getConfigProperty, initConfigHelper, updatePersistentConfigProperty } from './configHelper'
import { getSessionId } from './coflSessionManager'
import { sendWebhookInitialized } from './webhookHandler'
import { setupConsoleInterface } from './consoleHandler'
import { initAFKHandler, tryToTeleportToIsland } from './AFKHandler'
const WebSocket = require('ws')
var prompt = require('prompt-sync')()
initConfigHelper()
initLogger()
const version = '1.5.0-af'
let wss: WebSocket
let ingameName = getConfigProperty('INGAME_NAME')
let windowSkip = getConfigProperty('USE_WINDOW_SKIPS')

if (!ingameName) {
    ingameName = prompt('Enter your ingame name: ')
    updatePersistentConfigProperty('INGAME_NAME', ingameName)
}

if (windowSkip) {
    windowSkip = prompt('Window skips are detected. Would you like to disable them? (Type "illgetbanned" to use them, or press enter to proceed)');

    if (windowSkip.toLowerCase() !== 'illgetbanned') {
        updatePersistentConfigProperty('USE_WINDOW_SKIPS', false);
    }
}


const bot: MyBot = createBot({
    username: ingameName,
    auth: 'microsoft',
    logErrors: true,
    version: '1.17',
    host: 'mc.hypixel.net'
})
bot.setMaxListeners(0)

bot.state = 'gracePeriod'
createFastWindowClicker(bot._client)

if (getConfigProperty('LOG_PACKAGES')) {
    addLoggerToClientWriteFunction(bot._client)
}

bot.once('login', () => {
    connectWebsocket()
    bot._client.on('packet', function (packet, packetMeta) {
        if (packetMeta.name.includes('disconnect')) {
            wss.send(
                JSON.stringify({
                    type: 'report',
                    data: `"${JSON.stringify(packet)}"`
                })
            )
            printMcChatToConsole('§f[§4BAF§f]: §fYou were disconnected from the server...')
            printMcChatToConsole('§f[§4BAF§f]: §f' + JSON.stringify(packet))
        }
    })
})
bot.once('spawn', async () => {
    await bot.waitForChunksToLoad()
    await sleep(2000)
    bot.chat('/play sb')
    bot.on('scoreboardTitleChanged', onScoreboardChanged)
    registerIngameMessageHandler(bot, wss)
})

function connectWebsocket() {
    wss = new WebSocket(`wss://sky.coflnet.com/modsocket?player=${ingameName}&version=${version}&SId=${getSessionId(ingameName)}`)
    wss.onopen = function () {
        setupConsoleInterface(wss)
        sendWebhookInitialized()
    }
    wss.onmessage = onWebsocketMessage
    wss.onclose = function (_) {
        log('Connection closed. Reconnecting... ', 'warn')
        setTimeout(function () {
            connectWebsocket()
        }, 1000)
    }
    wss.onerror = function (err) {
        log('Connection error: ' + JSON.stringify(err), 'error')
        wss.close()
    }
}

async function onWebsocketMessage(msg) {
    let message = JSON.parse(msg.data)
    let data = JSON.parse(message.data)

    switch (message.type) {
        case 'flip':
            log(message, 'debug')
            flipHandler(bot, data)
            break
        case 'chatMessage':
            for (let da of [...(data as TextMessageData[])]) {
                let isCoflChat = isCoflChatMessage(da.text)
                if (!isCoflChat) {
                    log(message, 'debug')
                }
                if (getConfigProperty('USE_COFL_CHAT') || !isCoflChat) {
                    printMcChatToConsole(da.text)
                }
            }
            break
        case 'writeToChat':
            let isCoflChat = isCoflChatMessage(data.text)
            if (!isCoflChat) {
                log(message, 'debug')
            }
            if (getConfigProperty('USE_COFL_CHAT') || !isCoflChat) {
                printMcChatToConsole((data as TextMessageData).text)
            }
            break
        case 'swapProfile':
            log(message, 'debug')
            swapProfile(bot, data)
            break
        case 'createAuction':
            log(message, 'debug')
            onWebsocketCreateAuction(bot, data)
            break
        case 'trade':
            log(message, 'debug')
            tradePerson(bot, wss, data)
            break
        case 'tradeResponse':
            let tradeDisplay = (bot.currentWindow.slots[39].nbt.value as any).display.value.Name.value
            if (tradeDisplay.includes('Deal!') || tradeDisplay.includes('Warning!')) {
                await sleep(3400)
            }
            clickWindow(bot, 39)
            break
        case 'getInventory':
            log('Uploading inventory...')
            wss.send(
                JSON.stringify({
                    type: 'uploadInventory',
                    data: JSON.stringify(bot.inventory)
                })
            )
            break
        case 'execute':
            log(message, 'debug')
            if (data.startsWith('/cofl')) {
                let splits = data.split(' ')
                splits.shift() // remove /cofl
                let command = splits.shift()

                wss.send(
                    JSON.stringify({
                        type: command,
                        data: `"${splits.join(' ')}"`
                    })
                )
            } else {
                bot.chat(data)
            }
            break
        case 'privacySettings':
            log(message, 'debug')
            data.chatRegex = new RegExp(data.chatRegex)
            bot.privacySettings = data
            break
    }
}

async function onScoreboardChanged() {
    if (
        bot.scoreboard.sidebar.items.map(item => item.displayName.getText(null).replace(item.name, '')).find(e => e.includes('Purse:') || e.includes('Piggy:'))
    ) {
        bot.removeListener('scoreboardTitleChanged', onScoreboardChanged)
        log('Joined SkyBlock')
        initAFKHandler(bot)
        setTimeout(() => {
            log('Waited for grace period to end. Flips can now be bought.')
            bot.state = null
            bot.removeAllListeners('scoreboardTitleChanged')

            wss.send(
                JSON.stringify({
                    type: 'uploadScoreboard',
                    data: JSON.stringify(bot.scoreboard.sidebar.items.map(item => item.displayName.getText(null).replace(item.name, '')))
                })
            )
        }, 5500)
        await sleep(2500)
        tryToTeleportToIsland(bot, 0)

        await sleep(20000)
        // trying to claim sold items if sold while user was offline
        claimSoldItem(bot)
    }
}
