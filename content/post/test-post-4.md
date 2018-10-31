---
title: "Game design history"
date: 2018-10-30T15:01:15Z
draft: true
---

This post covers some of my earlier works and interests. Mostly during and before my undergraduate years (pre-2015) when I was getting to grips with programming, and before this blog existed.

Initially, I ventured out to learn more about programming, and more specifically game design. At this point my experience was mostly gained from making simple 3D games and using tools like blender to create models (most of which I've since lost the images of). To progress, I wanted to make a more serious RPG-like game that I could put on the app store. However, I had greatly underestimated the time to create the content (art work, levels, music, videos) for game. Creating a simple game engine which initially let you create (add lighting, computer players, and scene objects), load a previously created scene, and save new game scenes all through a graphical interface.

Here are a couple of images of the models that were used for advertising of the game:

<img class="wp-image-158 size-medium" src="" alt="Capture2" width="300"/> 

Blender render spaceship back
<!--more-->

<img class="wp-image-157 size-medium" src="" alt="Capture" width="300"/> 

Blender render spaceship front

Despite rendering these over 8 machines (though only using the CPU), the 20 second animation took 4 hours to render.

The game engine I created ended up being used for my final year project, unfortunately there was not an opportunity to carry on the engine as a game engine, so it (d)evolved into a home builder application.

For the basis of the game engine, I used LibGDX https://libgdx.badlogicgames.com/: a lightweight games graphics framework that works on most major platforms (Android, IOS, Windows, and OSX). I've been using LibGDX for 3 years on and off, initially came into contact with it after the frustration of creating games in android entirely from scratch with OpenGL2.0 (would not recommend other than for a learning experience).

So why did I use this over Unity (a popular game engine)? Well, to summarise, I used it because it was quicker to learn and was more hands on in terms of programming (which at the time is what I wanted to learn). Depending on what you're trying to create, I would generally suggest Unity over LibGDX, especially if you're just starting out. Unity has some great features like it's asset library, dependency management, and other various automation tools, all of which save time. The main downsides to Unity is that it has reduced flexibility as you're mainly restricted by what the engine provides, moreover, Unity is a large tool and learning how to use it takes a considerable length of time.
<div class="mceTemp"></div>
The following shows my final year project running on windows 8. It can be run on most operating systems, IOS, Android, Windows, and OSX.

<img class="" src="https://raw.githubusercontent.com/lyndon160/MiniArchitect/master/Arena.PNG" width="1816" /> MiniArchitect home design screenshot

<img class="" src="https://raw.githubusercontent.com/lyndon160/MiniArchitect/master/Arenahelp.PNG" width="1816"/> Gesture control help screen

All code for the project along with more information is available at https://github.com/lyndon160/MiniArchitect and should still be supported by the latest version of LibGDX at the time of writing this.

During the initial iteration of this, around 2013, I was testing on 2011-12 devices; a lot of effort went into minimising graphics and conserving resources. Using modern devices, the application can support larger houses and better models as well as detailed lighting.can be ran

Finally, all assets for the MiniArchitect project are CC, so feel free to use them however you like!
