const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const dotenv = require('dotenv');

dotenv.config();
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  token_uri: "https://oauth2.googleapis.com/token",
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore(); 

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.post("/api/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: "Todos los campos son obligatorios" });
    }

    const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "El formato del correo electrónico es inválido" });
    }

    const existingUser = await db.collection("users").where("email", "==", email).get();
    if (!existingUser.empty) {
      return res.status(400).json({ message: "El correo electrónico ya está registrado" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      displayName: username,
    });

    await db.collection("users").doc(userRecord.uid).set({
      email,
      username,
      last_login: admin.firestore.FieldValue.serverTimestamp(), 
      rol: "Empleado", 
      password: hashedPassword, 
    });

    res.status(201).json({ message: "Usuario registrado exitosamente", uid: userRecord.uid });
  } catch (error) {
    console.error("Error al registrar usuario:", error);
    res.status(500).json({ message: error.message });
  }
});

require('dotenv').config();
const moment = require('moment');

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "El correo y la contraseña son obligatorios" });
    }

    const userSnapshot = await db.collection("users").where("email", "==", email).get();
    if (userSnapshot.empty) {
      return res.status(400).json({ message: "Correo electrónico no encontrado" });
    }

    const userDoc = userSnapshot.docs[0];
    const user = userDoc.data();

    const passwordIsValid = await bcrypt.compare(password, user.password);
    if (!passwordIsValid) {
      return res.status(400).json({ message: "Contraseña incorrecta" });
    }

    const lastLogin = moment().format('D [de] MMMM [de] YYYY, h:mm:ss a');
    await db.collection("users").doc(userDoc.id).update({ last_login: lastLogin });

    const expirationTime = 10 * 60; 
    const token = jwt.sign(
      { uid: userDoc.id, email: user.email, username: user.username },
      process.env.JWT_SECRET,  // Usa la nueva clave secreta
      { expiresIn: expirationTime }
    );
    

    res.status(200).json({
      message: "Inicio de sesión exitoso",
      token,
      user: {
        docId: userDoc.id, 
        email: user.email,
        username: user.username,
        rol: user.rol,
        last_login: lastLogin
      }
    });
  } catch (error) {
    console.error("Error al iniciar sesión:", error);
    res.status(500).json({ message: error.message });
  }
});


app.post("/api/task", async (req, res) => {
  try {
    const { category, deadline, description, nameTask, status, userId, groupName } = req.body;

    // Verificación de campos obligatorios
    if (!category || !deadline || !description || !nameTask || !status || !userId) {
      return res.status(400).json({ message: "Todos los campos son obligatorios, excepto el nombre del grupo" });
    }

    // Validación del formato de la fecha límite
    const deadlineDate = moment(deadline, moment.ISO_8601);
    if (!deadlineDate.isValid()) {
      return res.status(400).json({ message: "El formato de la fecha límite es inválido" });
    }

    const firestoreDeadline = admin.firestore.Timestamp.fromDate(deadlineDate.toDate());

    // Verificar si ya existe una tarea con el mismo nombre y usuario
    const existingTasks = await db.collection("task")
      .where("nameTask", "==", nameTask)
      .where("userId", "==", userId)
      .get();

    if (!existingTasks.empty) {
      return res.status(400).json({ message: "Ya existe una tarea con este nombre para este usuario" });
    }

    // Crear tarea
    const task = {
      category,
      deadline: firestoreDeadline,
      description,
      nameTask,
      status,
      userId,
      groupName: groupName || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Guardar tarea en la base de datos
    const docRef = await db.collection("task").add(task);

    // Responder con éxito
    return res.status(201).json({ message: "Tarea creada exitosamente", id: docRef.id });
  } catch (error) {
    // Capturar errores del servidor
    console.error("Error al crear tarea:", error);
    res.status(500).json({ message: "Error interno del servidor. No se pudo crear la tarea." });
  }
});






app.get("/api/tasks", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ message: "El userId es obligatorio" });
    }
    const tasksSnapshot = await db.collection("task")
  .where("userId", "==", userId)
  .get();



    const tasks = tasksSnapshot.docs.map(doc => {
      const task = doc.data();
      return {
        id: doc.id,
        ...task,
        createdAt: task.createdAt ? task.createdAt.toDate().toISOString() : null,
        deadline: task.deadline ? task.deadline.toDate().toISOString() : null,
      };
    });
    res.status(200).json(tasks);
  } catch (error) {
    console.error("Error al obtener tareas:", error);
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/task/complete", async (req, res) => {
  try {
    const { taskId } = req.body;

    if (!taskId) {
      return res.status(400).json({ message: "El ID de la tarea es obligatorio" });
    }

    const taskDoc = await db.collection("task").doc(taskId).get();
    if (!taskDoc.exists) {
      return res.status(404).json({ message: "Tarea no encontrada" });
    }

    await db.collection("task").doc(taskId).update({ status: "Completada" });

    res.status(200).json({ message: "Tarea completada exitosamente" });
  } catch (error) {
    console.error("Error al completar tarea:", error);
    res.status(500).json({ message: error.message });
  }
});


app.post("/api/task/pending", async (req, res) => {
  try {
    const { taskId } = req.body;

    if (!taskId) {
      return res.status(400).json({ message: "El ID de la tarea es obligatorio" });
    }

    const taskDoc = await db.collection("task").doc(taskId).get();
    if (!taskDoc.exists) {
      return res.status(404).json({ message: "Tarea no encontrada" });
    }

    await db.collection("task").doc(taskId).update({ status: "Pendiente" });

    res.status(200).json({ message: "Estado de tarea cambiado a pendiente" });
  } catch (error) {
    console.error("Error al cambiar el estado de la tarea:", error);
    res.status(500).json({ message: error.message });
  }
});


app.delete("/api/task/delete", async (req, res) => {
  try {
    const { taskId } = req.body;

    if (!taskId) {
      return res.status(400).json({ message: "El ID de la tarea es obligatorio" });
    }

    const taskDoc = await db.collection("task").doc(taskId).get();
    if (!taskDoc.exists) {
      return res.status(404).json({ message: "Tarea no encontrada" });
    }

    await db.collection("task").doc(taskId).delete();

    res.status(200).json({ message: "Tarea eliminada exitosamente" });
  } catch (error) {
    console.error("Error al eliminar tarea:", error);
    res.status(500).json({ message: error.message });
  }
});


app.patch("/api/task/edit", async (req, res) => {
  try {
    const { taskId, category, deadline, description, nameTask, status } = req.body;

    if (!taskId) {
      return res.status(400).json({ message: "El ID de la tarea es obligatorio" });
    }

    const taskDoc = await db.collection("task").doc(taskId).get();
    if (!taskDoc.exists) {
      return res.status(404).json({ message: "Tarea no encontrada" });
    }

    const validCategories = ["Urgente", "Importante", "Pequeña"];
    const validStatuses = ["Completada", "Pendiente", "Pospuesta"];

    if (category && !validCategories.includes(category)) {
      return res.status(400).json({ message: "Categoría inválida" });
    }
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ message: "Estado inválido" });
    }

    const updatedTask = {};

    if (category) updatedTask.category = category;
    if (deadline) {
      const deadlineDate = moment(deadline, moment.ISO_8601);
      if (!deadlineDate.isValid()) {
        return res.status(400).json({ message: "El formato de la fecha límite es inválido" });
      }
      updatedTask.deadline = admin.firestore.Timestamp.fromDate(deadlineDate.toDate());
    }
    if (description) updatedTask.description = description;
    if (nameTask) updatedTask.nameTask = nameTask;
    if (status) updatedTask.status = status;

    await db.collection("task").doc(taskId).update(updatedTask);

    res.status(200).json({ message: "Tarea actualizada exitosamente" });
  } catch (error) {
    console.error("Error al editar tarea:", error);
    res.status(500).json({ message: error.message });
  }
});




// Ruta para obtener usuarios desde Firestore
app.get("/api/usuarios", async (req, res) => {
  try {
    const usersSnapshot = await db.collection("users").get(); // Asegúrate de que la colección "users" existe en Firestore
    
    if (usersSnapshot.empty) {
      console.log("No hay usuarios registrados");
      return res.status(404).json({ message: "No hay usuarios registrados" });
    }

    const users = usersSnapshot.docs.map(doc => {
      const user = doc.data();
      return {
        id: doc.id,
        email: user.email,
        username: user.username,
        rol: user.rol,
        last_login: user.last_login || "No disponible", // Asegúrate de que last_login esté bien gestionado en tu base
      };
    });

    console.log("Usuarios enviados:", users);
    res.status(200).json(users);
  } catch (error) {
    console.error("Error al obtener usuarios:", error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/groups', async (req, res) => {
  const { created_by, description, members, name } = req.body;

  try {
    // Paso 1: Verificar si ya existe un grupo con el mismo nombre para el mismo usuario
    const groupsRef = db.collection('groups');
    const snapshot = await groupsRef
      .where('created_by', '==', created_by)
      .where('name', '==', name)
      .get();

    if (!snapshot.empty) {
      // Si ya existe un grupo con ese nombre para este usuario, devolvemos un error
      return res.status(400).json({ message: "Ya existe un grupo con ese nombre para este usuario" });
    }

    // Paso 2: Si no existe, creamos el nuevo grupo
    const newGroup = {
      created_by,
      description,
      members,
      name,
      created_at: new Date(), // Fecha de creación
    };

    // Inserta el grupo en la colección 'groups' de Firestore
    const docRef = await db.collection('groups').add(newGroup);
    res.status(201).json({ id: docRef.id, ...newGroup });
  } catch (error) {
    console.error("Error al crear el grupo:", error);
    res.status(500).json({ message: "Error al crear el grupo" });
  }
});


app.get("/api/groups", async (req, res) => {
  try {
    const { userId } = req.query;  // El ID del usuario debe ser pasado en la query

    if (!userId) {
      return res.status(400).json({ message: "El userId es obligatorio" });
    }

    console.log("Buscando grupos para el userId:", userId);  // Mostrar el userId en la consola

    // Obtener los grupos que contienen al usuario en 'members' o el usuario es el 'created_by'
    const groupsSnapshot = await db.collection("groups")
      .where("members", "array-contains", userId)
      .get();

    // Si no se encuentran grupos, también verificamos si el usuario es el creador
    if (groupsSnapshot.empty) {
      console.log("No se encontraron grupos por membresía, verificando creador...");

      // Verificar si el usuario es el creador de algún grupo
      const createdGroupsSnapshot = await db.collection("groups")
        .where("created_by", "==", userId)
        .get();

      if (createdGroupsSnapshot.empty) {
        return res.status(404).json({ message: "No se encontraron grupos para este usuario" });
      }

      const createdGroups = createdGroupsSnapshot.docs.map(doc => {
        const group = doc.data();
        return {
          id: doc.id,
          name: group.name,
          description: group.description,
          createdAt: group.createdAt ? group.createdAt.toDate().toISOString() : null,  // Convertir fecha a formato ISO
          members: group.members,
        };
      });

      console.log("Grupos creados encontrados:", createdGroups);  // Mostrar los grupos creados en la consola
      return res.status(200).json(createdGroups);
    }

    const groups = groupsSnapshot.docs.map(doc => {
      const group = doc.data();
      return {
        id: doc.id,
        name: group.name,
        description: group.description,
        createdAt: group.createdAt ? group.createdAt.toDate().toISOString() : null,  // Convertir fecha a formato ISO
        members: group.members,
      };
    });


    res.status(200).json(groups);
  } catch (error) {
    console.error("Error al obtener los grupos:", error);  // Mostrar el error en la consola
    res.status(500).json({ message: error.message });
  }
});




// Editar un grupo
app.put("/api/groups/:id", async (req, res) => {
  try {
    const groupId = req.params.id;
    const { name, description, members } = req.body;

    if (!name || !description || !Array.isArray(members)) {
      return res.status(400).json({ message: "Los campos nombre, descripción y miembros son obligatorios" });
    }

    const groupRef = db.collection("groups").doc(groupId);
    const groupSnapshot = await groupRef.get();

    if (!groupSnapshot.exists) {
      return res.status(404).json({ message: "Grupo no encontrado" });
    }

    // Actualizar el grupo
    await groupRef.update({
      name,
      description,
      members,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ message: "Grupo editado exitosamente" });
  } catch (error) {
    console.error("Error al editar el grupo:", error);
    res.status(500).json({ message: error.message });
  }
});


app.delete("/api/groups/:id", async (req, res) => {
  try {
    const groupId = req.params.id;
    const { userId } = req.query;  // El email del usuario que hace la solicitud

    if (!userId) {
      return res.status(400).json({ message: "El userId es obligatorio" });
    }

    // Obtener el grupo desde la base de datos
    const groupRef = db.collection("groups").doc(groupId);
    const groupSnapshot = await groupRef.get();

    if (!groupSnapshot.exists) {
      return res.status(404).json({ message: "Grupo no encontrado" });
    }

    const group = groupSnapshot.data();

    // Verificar si el usuario es el creador del grupo
    if (group.created_by !== userId) {
      return res.status(403).json({ message: "No tienes permisos para eliminar este grupo" });
    }

    // Eliminar el grupo
    await groupRef.delete();

    res.status(200).json({ message: "Grupo eliminado exitosamente" });
  } catch (error) {
    console.error("Error al eliminar el grupo:", error);
    res.status(500).json({ message: "Error al eliminar el grupo" });
  }
});





// Ruta para obtener los grupos a los que pertenece un usuario
app.get("/api/misgrupos", async (req, res) => {
  try {
    const { userId } = req.query;  // El ID del usuario debe ser pasado en la query

    if (!userId) {
      return res.status(400).json({ message: "El userId es obligatorio" });
    }

    console.log("Buscando grupos para el userId:", userId);  // Mostrar el userId en la consola

    // Obtener los grupos que contienen al usuario en 'members' o el usuario es el 'created_by'
    const groupsSnapshot = await db.collection("groups")
      .where("members", "array-contains", userId)  // Filtra los grupos donde el usuario está en 'members'
      .get();

    if (groupsSnapshot.empty) {
      return res.status(404).json({ message: "El usuario no pertenece a ningún grupo" });
    }

    // Mapear los resultados y convertir el campo 'created_at' a un formato ISO
    const groups = groupsSnapshot.docs.map(doc => {
      const group = doc.data();
      return {
        id: doc.id,
        name: group.name,
        description: group.description,
        created_by: group.created_by,
        members: group.members,
        created_at: group.created_at ? group.created_at.toDate().toISOString() : null,  // Asegurarse de convertir la fecha a formato ISO
      };
    });

    res.status(200).json(groups);
  } catch (error) {
    console.error("Error al obtener los grupos:", error);
    res.status(500).json({ message: error.message });
  }
});


app.get("/api/tareas", async (req, res) => {
  try {
    const { groupId } = req.query; // Aquí obtenemos el ID del grupo que queremos filtrar
    let tareasRef = db.collection("task");

    if (groupId) {
      // Filtramos las tareas por el campo groupName, que es igual al ID del grupo
      tareasRef = tareasRef.where("groupName", "==", groupId); // Comparamos groupName con el groupId
    }

    const snapshot = await tareasRef.get();

    if (snapshot.empty) {
      return res.status(200).json([]); // Si no hay tareas, respondemos con un arreglo vacío
    }

    const tareas = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json(tareas); // Respondemos con las tareas encontradas
  } catch (error) {
    console.error("Error al obtener tareas:", error);
    res.status(500).json({ message: "Error al obtener las tareas" });
  }
});




app.put("/api/tareas/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["Por hacer", "En proceso", "Hecho"].includes(status)) {
      return res.status(400).json({ message: "Estado inválido" });
    }

    const tareaRef = db.collection("task").doc(id);
    await tareaRef.update({ status });

    res.status(200).json({ message: "Estado actualizado correctamente" });
  } catch (error) {
    console.error("Error al actualizar estado:", error);
    res.status(500).json({ message: "Error al actualizar la tarea" });
  }
});

app.get("/api/usuarios", async (req, res) => {
  try {
    const usersSnapshot = await db.collection("users").get();

    if (usersSnapshot.empty) {
      return res.status(404).json({ message: "No hay usuarios registrados" });
    }

    const users = usersSnapshot.docs.map(doc => {
      const user = doc.data();
      return {
        id: doc.id,
        email: user.email || "No disponible",
        username: user.username || "No disponible",
        rol: user.rol || "No disponible",
        last_login: user.last_login || "No disponible",
      };
    });

    // Aquí no hay console.log innecesario
    res.status(200).json(users);
  } catch (error) {
    console.error("Error al obtener usuarios:", error);
    res.status(500).json({ message: "Error al obtener los usuarios" });
  }
});



app.put("/api/usuarios/:id", async (req, res) => {
  const { id } = req.params;
  const { email, username, rol } = req.body;
  
  try {
    const userRef = db.collection('users').doc(id);
    await userRef.update({
      email,
      username,
      rol,
    });
    res.status(200).json({ message: "Usuario actualizado exitosamente" });
  } catch (error) {
    console.error("Error al actualizar el usuario:", error);
    res.status(500).json({ message: "Error al actualizar el usuario" });
  }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});



