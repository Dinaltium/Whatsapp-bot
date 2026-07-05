Fix #1

Generic Bot can message anyone but its should be heavily restricted and give generic answer. (Feature)
Generic Bot can answer but limited to 3 messages per number. (Improvement)
Generic Bot can't answer in group chats. (Improvement)
Generic Bot should not answer anything outside of basic prompts like Hi, Hey bro or anything basic. Even if the person where to ask a question, Generic bot should not answer it. (Improvement)
Generic bot can get triggered in 2 ways when the messager is messaging my number: 1. Offline answer, works when the person is messaging me and I am offline, the bot will respond saying, hi Rafan is offline atm or something like that. 2. Invoked by !<message>, allows generic responses only and should not answer anything outside of this. ; All of these share the same 3 message limit before the bot stops responding or even replying or reading the message. (Feature)
Generic Bot can answer a message sent by the person for the first time of the day like any introductory or any messages but any messages sent afterwards should not be answered unless invoked with !. In other words their 3 message limit starts with the first message answering them like that with the remaining two being answered with ! only. Should reset the next day or a 24hr limit, whichever is better. (Improvement)
Generic bot should know if I am offline or online at the time the person messages me. If I am online, generic bot should not step in to answer. (Feature)
You can place a small little message after the bots message: Something like: Beep Bop, I am bot, Use ! to know more about me, You have 2 chances for the day. Something like that (Improvement)
Using !reset won't be effected by message limit but should also not be a way to bypass the limit. (improvement)
Using !whoami, which is supposed to show my jid and normalized, only shows normalized in both:
Your JID: 919902849280@s.whatsapp.net
Normalized: 919902849280@s.whatsapp.net
Fix this bug (bug)
Using !whoami should not work in any other chat except my own chat. This is a big vulnerability to my account. It also cannot be used by others. Right now they can use it plus this command I can run it in other chats/group which should not happen. (bug)
!getjid should only work from admin use, should not be used by the other person in the chat. Only I/admin can invoke it in the chat and not them (bug)
!reset should be updated. It currently answers with "Context reset for your session. Start with a new !tech or !hackathon question." which it should remain different for different bots. Reset should not be effected by bot limit usage which otherwise people can take advantage of. (improvement)
-id for bot when using !help should be changed with -bot or -b instead (improvement)
If an admin invokes !help, he can pretty much see all available commands (excluding bot commands unless -b is mentioned). So instead it should show like addchat, rmchat or something like that but to admin. To the general, its just the basic. (Improvement)
!ping can only be used by me and not others (improvement)
We will change addchat or addgroup to !add -g/-c, so basically unifying the process. Same to be applied to others to unify them. (Improvement)
Using !add -c/-g in a chat or group respectively should automatically fetch the jid of the group and add it to the list but gets bot 0 unless -b is used to specify in the command. Ex: !add -c -b 2; adds bot 2 in the chat I used this message but if I specify the jid like in this case !add -c 136249347932495@lid -b 2 (the jid is wrong so don't worry); then it will add that jid to the list even if I use it in any chat. Otherwise just the chat or group I am in, it gets added. (Improvement)
We will remove bot headers completely from every bot like this one from DKB: DK-Bot-692. (Fix)


Fix #2