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

General bot should be available as default bot to every user messaging me (those in my contacts) (improvement)
General bot should be able to read any messages that comes when I am offline and send a notification to my laptop (feature)
General bot messages even when I am online in WhatsApp (30seconds have not passed) but not in the tab, it still somehow messages (Bug)
General bot usage instruction should be modified; replace !<message> with just !message because I got my friend who messaged me in the morning failing to use his IQ to use the command correctly. Here is how he used it:

---

!<remind him to send me the necessary details regarding the llp registration which includes
[2:18 pm, 26/06/2026] Prateek D Shriyan: PAN, Aadhaar of all 3 partners
Passport-size photos
Email IDs and mobile numbers
Address proof of all partners
[2:19 pm, 26/06/2026] Prateek D Shriyan: Obtain DSCs (Digital Signature Certificates) >

---

I'm just the owner's auto-reply bot, I won't be able to help with that, the owner will get back to you when they return. Hope you're doing well!

## _Beep bop — I'm the owner's bot. Send !<message> to talk to me. 1 reply left today._

## !<fuck off then >

So for guys like him better if we improve the text to show usage (Improvement)
General bot no longer needs any assignment as 0 or anything, rather it comes defaulted to any one including chats that already have a bot assigned to them. Which means default will be 0 for every chat but none for group. When I add the chat or group to allow list, default is 1 if I don't mention any bot id (Improvement)
The command !add -c/-g -b should be modified. If I am in a chat like, then by default have the bot know I am in a chat which doesn't require me to use -c/-g and I could directly use !add -b 2 or something like that. I can also do !add -c/-g with or without jid but for simplicity if possible, just doing !add should be enough (even without assigning a bot) (Improvement)
Improve the bot commands for !help command every time we make change. Plus simplify but to the point. (Improvement)
!rm command should also work in the chat or group I am using it. If I am in the group and use just !rm, it should know the group jid and what bot its currently using and remove that from the list. (Improvement)
Same for !edit, !enable, !disable, if I am in the chat or group and calling this command, I can use it directly without using !cid or !gid and use other parameters if required instead. (Improvement)
Change any commands that use -b to using only -bid to make it easier and consistent. No backwards compatibility.
Mentor role management used by DKB will go through some clean changes:

1. Mentor role can be manually added or bulk added or removed. The current !manage needs to be completely changed from how it is to just doing like this: !manage mentor -all, will give everyone mentor role if I use it in the group, !manage mentor -l will list everyone who got the mentor role, !manage mentor -all -rm will remove the mentor role from everyone if used in group, !manage mentor -jid phone_number will add the specific person to have the mentor role.
2. Mentor role should have a cooldown to prevent mass spam and usage
3. Mentor role only gets to remove or add or edit mentors and nothing else to do. Aside from having that, they can do other things unless blocked from doing it.
   So just look into this (Feature)
   The desktop messaging should use less emojis and more professional wording. Even if the person in the chat has bot access like 1/2/3, they still can use 0 with limitation and instead of keeping it 3 messages per day, we will keep it 5 messages per 3-4hrs. We will also make sure that the general bot doesn't repeat twice for the message. General bot can also read non !message command chats but they can't respond to any unless this is !message used but I think instead of setting !message like !chat some message.

#Fix 3
