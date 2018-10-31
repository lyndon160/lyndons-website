---
title: "Test Post 3"
date: 2018-10-30T15:01:14Z
draft: true
---

This post is an attempt to simplify the processes of using "Steam in-home streaming" over the Internet, via a VPN without using propriety solutions.</em>

Steam in-home streaming is a service that provides private game streaming from your personal gaming computer to another computer (i.e. your laptop or other computer).

[What is it and how does it work (Screenshots)]

There are various reasons you might want to use steam in-home streaming: It's cross platform and works on all major platforms, OSX, Linux, Windows. Moreover, you can stream the games to your laptop, makes playing on the couch a little bit better. Also, your client devices wont get hot and in-turn won't activate its fans. The battery of the client device will last longer. With my Macbook Pro I can get a good 5 hours (stream) gaming out of it!

However, it's not perfect: Some games don't work and my require some effort to work. Also, depending on your graphics card and host operating system you may experience flickering. Its only in-home. It could be due to one of the following challenges with streaming over the Internet: maintenance effort,  licensing, economical benefits, increased Internet traffic.

Disclimers

To make the performance bearable you need to have a pretty good uplink (3mbps) at the server side and the same at the downlink side

Firstly, we need to identify why the steam stream protocol does not work over the Internet/different subnets.

[Wireshark screenshot]

The packet seen here is used by steam for discovery of neighbours. As it is using a broadcast destination IP (255.255.255.255) any router will drop it and not forward it. Hence why this will not work over the Internet.

VPN
<ul>
<li>what is it?</li>
<li>tap and tun?</li>
</ul>
Tun creates a subnet for VPN clients to connect to. This means the t

Tap creates a bridge for VPN clients to connect to  (all on the same subnet).

Because we need to use broadcast messages for the discovery protocol we have to use Tap. Tun will drop broadcast messages when it routes traffic.]
